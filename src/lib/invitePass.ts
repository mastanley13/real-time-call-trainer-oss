/**
 * The invite pass: how someone invited to a team gets past the optional TRAINER_ACCESS_CODE gate to finish that one
 * invite, without the access code. Shared by the middleware (edge) and the Node routes, so Web Crypto only.
 *
 * GET /api/invites/gate/<token> checks the invite in the database. Only for an open invite (not accepted, revoked
 * or expired) does it set this cookie: the invite id, the sha256 of its token and an expiry (30 minutes, or the
 * invite's own expiry if sooner), HMAC-signed with JWT_SECRET. With no usable JWT_SECRET nothing is signed and
 * nothing verifies, so the gate stays shut.
 *
 * The middleware lets the pass through to the invite's own page and the invite preview and accept APIs, nothing
 * else (login, register and /api/auth/* are public anyway). Preview, accept and register also check that the
 * token in the request body is the one the pass was issued for. "Continue with Google" from the invite (a public
 * /api/auth/* route) binds the invite into its signed flow only when the pass matches it.
 *
 * An accepted invite counts as site access: /api/invites/accept, and the Google callback for a brand-new account,
 * accept the invite atomically and only then set the same access cookie that entering the code sets
 * (grantAccessCookie in access.ts). Both clear the pass.
 */
import { accessCode, hasValidAccessCookie, hmacHex, safeEqual } from "./access";

export const INVITE_PASS_COOKIE = "invite_pass";
export const INVITE_PASS_TTL_MS = 30 * 60_000;

/** Same shape as INVITE_TOKEN_RE in invites.ts, kept here so the middleware does not pull in zod. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_PAGE = /^\/invite\/([A-Za-z0-9_-]{43})$/;
const GATE_ROUTE = /^\/api\/invites\/gate\/([A-Za-z0-9_-]{43})$/;
/** APIs the invite page calls. Each one checks the body's token against the pass again. */
const PASS_APIS = new Set(["/api/invites/preview", "/api/invites/accept"]);

export interface InvitePass { inviteId: string; tokenHash: string; expiresAt: number }

/** The signing key: JWT_SECRET when it is set and long enough (the same rule as auth.ts), else null. */
function passKey(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.JWT_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const payload = (p: InvitePass) => `${p.inviteId}.${p.tokenHash}.${p.expiresAt}`;
const signed = (key: string, p: InvitePass) => hmacHex(key, `invite-pass:v1:${payload(p)}`);

/** The cookie value, or null when there is no usable key (fail closed). */
export async function signInvitePass(p: InvitePass): Promise<string | null> {
  const key = passKey();
  if (!key) return null;
  return `${payload(p)}.${await signed(key, p)}`;
}

/** The pass in a cookie value when its signature is good and it has not expired, else null. */
export async function readInvitePass(value: string | undefined | null, now = Date.now()): Promise<InvitePass | null> {
  const key = passKey();
  if (!key || !value || value.length > 400) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [inviteId, tokenHash, exp, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(inviteId) || !/^[0-9a-f]{64}$/.test(tokenHash) || !/^[0-9]{1,15}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const pass = { inviteId, tokenHash, expiresAt: Number(exp) };
  if (!safeEqual(sig, await signed(key, pass))) return null;
  // Never trust a pass that claims to live longer than one is ever issued for.
  if (pass.expiresAt <= now || pass.expiresAt > now + INVITE_PASS_TTL_MS) return null;
  return pass;
}

/** True when `pass` was issued for this raw token. */
export async function passMatchesToken(pass: InvitePass, token: string): Promise<boolean> {
  return TOKEN.test(token) && safeEqual(pass.tokenHash, await sha256Hex(token));
}

type CookieReq = { cookies: { get(name: string): { value: string } | undefined } };

/** The request's pass, verified, or null. */
export const passFrom = (req: CookieReq, now = Date.now()) => readInvitePass(req.cookies.get(INVITE_PASS_COOKIE)?.value, now);

/** True when the request has the access code, or the gate is off. */
export async function hasSiteAccess(req: CookieReq): Promise<boolean> {
  const code = accessCode();
  return !code || (await hasValidAccessCookie(req, code));
}

/**
 * For the routes a pass opens: may this request act on the invite with this raw token? Always with the access code
 * (or no gate); otherwise only with a pass issued for exactly this token. The middleware cannot read request
 * bodies, so this is where a pass for one invite is kept from being used on another.
 */
export async function gateAllowsInvite(req: CookieReq, token: string): Promise<boolean> {
  if (await hasSiteAccess(req)) return true;
  const pass = await passFrom(req);
  return !!pass && (await passMatchesToken(pass, token));
}

export const passRequired = () =>
  Response.json({ error: "access_code_required", message: "Open your invite link again to continue, or enter the access code." }, { status: 401 });

/** The token in "/invite/<token>", or null. */
export const invitePageToken = (pathname: string) => pathname.match(INVITE_PAGE)?.[1] ?? null;
/** The token in "/api/invites/gate/<token>", or null. */
export const gateRouteToken = (pathname: string) => pathname.match(GATE_ROUTE)?.[1] ?? null;

/** What the pass opens: this invite's page, and the invite preview and accept APIs. Nothing else. */
export async function invitePassAllows(pathname: string, pass: InvitePass): Promise<boolean> {
  if (PASS_APIS.has(pathname)) return true;
  const token = invitePageToken(pathname);
  return !!token && (await passMatchesToken(pass, token));
}

/** httpOnly, SameSite=Lax, path /, Secure everywhere but `next dev` on plain http. */
export function invitePassCookie(maxAgeSec: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax" as const, path: "/", maxAge: Math.max(0, Math.floor(maxAgeSec)) };
}

/** Query flag the gate route adds on its way back, so a browser that drops the cookie lands on /access, not a loop. */
export const PASS_RETURN_FLAG = "pass";

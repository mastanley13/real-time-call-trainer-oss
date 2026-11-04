import "server-only";
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getJwtSecret } from "./auth";
import { safeNextPath } from "./safeNext";
import { cleanSignupIntent } from "./signupIntent";

/**
 * Google sign-in: OAuth 2.0 authorization code flow with PKCE, state and nonce. No extra packages: the ID token
 * comes straight from Google's token endpoint over TLS, so (per OpenID Connect Core 3.1.3.7) we check its claims
 * rather than its signature.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
export const GOOGLE_FLOW_COOKIE = "g_oauth";
export const GOOGLE_FLOW_COOKIE_PATH = "/api/auth/google";
const FLOW_TTL_SEC = 600;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type Env = Record<string, string | undefined>;

/** The public origin from APP_URL, or null when it is unset or not an http(s) URL. The Host header is never used. */
function appOrigin(env: Env): string | null {
  const raw = env.APP_URL?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Null unless GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL and DATABASE_URL are set. Demo mode never offers Google. */
export function googleConfig(env: Env = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const origin = appOrigin(env);
  if (!env.DATABASE_URL?.trim()) return null;
  if (!clientId || !clientSecret || !origin || env.DEMO_MODE === "true") return null;
  return { clientId, clientSecret, redirectUri: `${origin}/api/auth/google/callback` };
}

/**
 * Writes googleSub only while the account still has no Google id and is not locked, in one statement, so two
 * concurrent sign-ins or a lockout in between cannot be overwritten. Returns false when nothing was written
 * (lost the race, locked, or the id belongs to another account).
 */
export async function linkGoogleAtomically(
  db: { user: { updateMany: (args: { where: Record<string, unknown>; data: { googleSub: string } }) => Promise<{ count: number }> } },
  userId: string,
  googleSub: string,
): Promise<boolean> {
  try {
    const { count } = await db.user.updateMany({
      where: { id: userId, googleSub: null, OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
      data: { googleSub },
    });
    return count === 1;
  } catch {
    return false;
  }
}

export const googleEnabled = (env: Env = process.env): boolean => googleConfig(env) !== null;

const b64url = (buf: Buffer) => buf.toString("base64url");
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export { safeNextPath };

/** What we remember between /start and /callback, signed into a short-lived cookie. */
export const FlowStateSchema = z.object({
  state: z.string().min(16).max(100),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(100),
  next: z.string().max(200),
  /** Whitelisted sign-up intent (plan, interval, src, seg) from /register. Re-cleaned on read. */
  intent: z
    .object({
      plan: z.string().max(10).optional(),
      interval: z.string().max(10).optional(),
      src: z.string().max(40).optional(),
      seg: z.string().max(40).optional(),
    })
    .optional(),
});
export type FlowState = z.infer<typeof FlowStateSchema>;

export function signFlowState(flow: FlowState): string {
  return jwt.sign({ ...flow, purpose: "google-flow" }, getJwtSecret(), { expiresIn: FLOW_TTL_SEC });
}

export function verifyFlowState(token: string | undefined): FlowState | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    if (payload.purpose !== "google-flow") return null;
    const parsed = FlowStateSchema.safeParse(payload);
    return parsed.success ? { ...parsed.data, intent: cleanSignupIntent(parsed.data.intent) } : null;
  } catch {
    return null;
  }
}

export const flowCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: GOOGLE_FLOW_COOKIE_PATH,
  maxAge: FLOW_TTL_SEC,
});

export function authorizeUrl(cfg: GoogleConfig, flow: Pick<FlowState, "state" | "nonce" | "verifier">): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export interface GoogleProfile {
  sub: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  sub: z.string().min(1).max(255),
  email: z.string().email().max(254),
  email_verified: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  nonce: z.string().optional(),
  given_name: z.string().max(200).optional(),
  family_name: z.string().max(200).optional(),
});

export type ClaimsCheck = { ok: true; profile: GoogleProfile } | { ok: false; reason: string };

/** Checks an ID token's claims. Pure apart from the clock, which the caller passes in. */
export function checkIdTokenClaims(claims: unknown, expect: { clientId: string; nonce: string; nowSec: number }): ClaimsCheck {
  const parsed = ClaimsSchema.safeParse(claims);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const c = parsed.data;
  if (!GOOGLE_ISSUERS.has(c.iss)) return { ok: false, reason: "issuer" };
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!audiences.includes(expect.clientId)) return { ok: false, reason: "audience" };
  if (c.exp <= expect.nowSec) return { ok: false, reason: "expired" };
  if (c.nonce !== expect.nonce) return { ok: false, reason: "nonce" };
  if (c.email_verified !== true && c.email_verified !== "true") return { ok: false, reason: "email_unverified" };
  return {
    ok: true,
    profile: {
      sub: c.sub,
      email: c.email.toLowerCase(),
      firstName: c.given_name?.trim().slice(0, 80) || undefined,
      lastName: c.family_name?.trim().slice(0, 80) || undefined,
    },
  };
}

/** Swaps the authorization code for tokens. Logs only the status code on failure. */
export async function exchangeCode(cfg: GoogleConfig, code: string, verifier: string): Promise<{ idToken: string } | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(`[google] token exchange failed with status ${res.status}`);
    return null;
  }
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof body?.id_token === "string" ? { idToken: body.id_token } : null;
}

/** Decodes the ID token payload. Safe only because it came straight from GOOGLE_TOKEN_URL over TLS. */
export function decodeIdToken(idToken: string): unknown {
  return jwt.decode(idToken);
}

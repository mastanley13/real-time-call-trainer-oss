import "server-only";
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getJwtSecret } from "./auth";

/**
 * Google sign-in: OAuth 2.0 authorization code flow with PKCE, state and
 * nonce. No extra packages: the ID token comes straight from Google's token
 * endpoint over TLS, so (per OpenID Connect Core 3.1.3.7) we check its
 * claims rather than its signature.
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

/** Null unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. Demo mode never offers Google. */
export function googleConfig(requestOrigin?: string): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || process.env.DEMO_MODE === "true") return null;
  // APP_URL pins the callback, so a spoofed Host header can't change where Google sends the code.
  const base = (process.env.APP_URL?.trim() || requestOrigin || "").replace(/\/$/, "");
  if (!base) return null;
  return { clientId, clientSecret, redirectUri: `${base}/api/auth/google/callback` };
}

export function googleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim() && process.env.DEMO_MODE !== "true");
}

const b64url = (buf: Buffer) => buf.toString("base64url");
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

/** Only same-site paths: "/x", never "//host" or "/\host". */
export function safeNextPath(raw: string | null | undefined, fallback = "/trainer"): string {
  if (!raw || raw.length > 200) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(raw)) return fallback;
  return raw;
}

/** What we remember between /start and /callback, signed into a short-lived cookie. */
export const FlowStateSchema = z.object({
  state: z.string().min(16).max(100),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(100),
  next: z.string().max(200),
  joinCode: z.string().regex(/^[0-9]{3,8}$/).optional(),
  managerId: z.string().min(1).max(64).optional(),
  /** "team" leaves a new user without an org so onboarding can start a team. Anything else is solo. */
  intent: z.enum(["solo", "team"]).optional(),
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
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const flowCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: GOOGLE_FLOW_COOKIE_PATH,
  maxAge: FLOW_TTL_SEC,
};

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

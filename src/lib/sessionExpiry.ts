/**
 * Stale-session recovery for the browser. The UI decides "signed in" from localStorage, but API routes
 * authenticate with the httpOnly cookie (requireAuth in apiAuth.ts). When the cookie is missing, expired or
 * unverifiable, every API call answers 401 while the UI still looks signed in. AuthProvider installs one
 * fetch wrapper that spots those 401s, clears the client session and sends the user to /login?next=.
 *
 * Client-safe and pure apart from installSessionExpiryGuard, which takes its window-like target as an
 * argument so tests can run it in node.
 */
import { validNextPath } from "./safeNext";

/** The 401 bodies requireAuth sends for a bad session. Any other 401 (for example access_code_required) is left alone. */
export const SESSION_401_ERRORS: readonly string[] = ["Authentication required", "Invalid or expired session"];

/** Query value the login page keys its "session expired" notice on. */
export const EXPIRED_REASON = "expired";

/** Pages where an expired-session redirect must not carry a next, because they are the sign-in flow itself. */
const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password", "/access"];

/** Largest 401 body we read when deciding. requireAuth's bodies are well under this. */
const MAX_BODY_BYTES = 2048;

const onPath = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/**
 * True for same-origin /api/ requests where a 401 means a stale session. /api/auth/* (login, MFA, register,
 * reset, session restore, logout, Google) and /api/access answer 401 as a normal result, so they are excluded.
 */
export function isSessionGuardedUrl(rawUrl: string, origin: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;
  if (onPath(p, "/api/auth") || onPath(p, "/api/access")) return false;
  return true;
}

/** True when a parsed 401 body is one of requireAuth's session errors. */
export function isSessionExpiryBody(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const error = (body as { error: unknown }).error;
  return typeof error === "string" && SESSION_401_ERRORS.includes(error);
}

/** Reads at most MAX_BODY_BYTES of a response (pass a clone) and checks for a session error. Never throws. */
export async function responseIsSessionExpiry(res: Response): Promise<boolean> {
  if (res.status !== 401 || !res.body) return false;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    return false;
  } finally {
    reader.cancel().catch(() => {});
  }
  if (size > MAX_BODY_BYTES) return false;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try {
    return isSessionExpiryBody(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return false;
  }
}

/**
 * Where to send a user whose session expired, or null to stay put (already on /login).
 * On another sign-in page, or when the current path fails validNextPath, the link carries no next.
 */
export function expiredLoginHref(pathname: string, search: string): string | null {
  if (onPath(pathname, "/login")) return null;
  const params = new URLSearchParams();
  const next = AUTH_PAGES.some((p) => onPath(pathname, p)) ? null : validNextPath(`${pathname}${search}`);
  if (next) params.set("next", next);
  params.set("reason", EXPIRED_REASON);
  return `/login?${params.toString()}`;
}

export interface SessionGuardTarget {
  fetch: typeof fetch;
  location: { origin: string; pathname: string; search: string; assign: (url: string) => void };
}

export interface SessionGuardOptions {
  /**
   * The current client session (localStorage authToken), or null when signed out. Read when a request starts
   * and again when its 401 is handled; only the same session is expired, so a late 401 from before a sign-out
   * and new sign-in never clears the new session. Signed-out visitors are never redirected.
   */
  currentSession: () => string | null;
  /** Demo mode has no sessions to expire. */
  isDemo: () => boolean;
  /** Clears the client session (AuthContext clearSession). */
  onExpired: () => void;
}

const WRAPPED = Symbol.for("ct.sessionExpiryGuard");
/** The wrapper carries its live options, so a repeat install (for example after a hot reload) refreshes them. */
type Wrapped = typeof fetch & { [WRAPPED]?: SessionGuardOptions };

/** Set once a redirect is under way, so parallel 401s don't stack navigations. */
let redirecting = false;

/** Test hook: forget a previous redirect. */
export function resetSessionExpiryRedirect(): void {
  redirecting = false;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Runs after a guarded 401: decides, clears the session and redirects at most once. `session` is what
 * currentSession() returned when the request started.
 */
export async function handleGuarded401(
  res: Response,
  session: string | null,
  target: SessionGuardTarget,
  opts: SessionGuardOptions,
): Promise<void> {
  if (redirecting || !session) return;
  if (!(await responseIsSessionExpiry(res))) return;
  if (redirecting || opts.isDemo() || opts.currentSession() !== session) return;
  opts.onExpired();
  const href = expiredLoginHref(target.location.pathname, target.location.search);
  if (!href) return;
  redirecting = true;
  target.location.assign(href);
}

/**
 * Wraps target.fetch. The caller always gets the original response untouched; a clone is inspected in the
 * background. Idempotent: a second install while one is active only refreshes the options. A no-op when the
 * target or its fetch is missing (server rendering, tests that stub window). Returns an uninstaller.
 */
export function installSessionExpiryGuard(target: SessionGuardTarget | undefined, opts: SessionGuardOptions): () => void {
  if (!target || typeof target.fetch !== "function" || !target.location) return () => {};
  const existing = target.fetch as Wrapped;
  if (existing[WRAPPED]) {
    existing[WRAPPED] = opts;
    return () => {};
  }
  const original = target.fetch;
  const wrapped: Wrapped = async (input, init) => {
    const live = wrapped[WRAPPED] ?? opts;
    let guarded = false;
    let session: string | null = null;
    try {
      guarded = isSessionGuardedUrl(requestUrl(input), target.location.origin);
      session = guarded ? live.currentSession() : null;
    } catch {
      guarded = false;
    }
    const res = await original(input, init);
    if (guarded && session && res.status === 401) {
      let copy: Response | null = null;
      try {
        copy = res.clone();
      } catch {
        copy = null;
      }
      if (copy) void handleGuarded401(copy, session, target, live).catch(() => {});
    }
    return res;
  };
  wrapped[WRAPPED] = opts;
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
  };
}

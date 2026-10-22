/**
 * Lightweight in-memory rate limiter.
 *
 * Good enough for single-instance deployments and demo pilots. For multi-node
 * production, swap in a Redis-backed implementation — the interface stays the
 * same.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Unique identifier for the limit scope, e.g. "session:<userId>". */
  key: string;
  /** Max requests allowed in the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(opts.key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(opts.key, { count: 1, resetAt: now + opts.windowMs });
    return { allowed: true, remaining: opts.limit - 1, retryAfterMs: 0 };
  }

  if (existing.count >= opts.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: existing.resetAt - now,
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: opts.limit - existing.count,
    retryAfterMs: 0,
  };
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-IP limits for cost-bearing routes. Configurable via env (see README).
 * NOTE: state is in-memory and per serverless instance, so on Vercel the limit
 * is best-effort (each warm instance counts separately, cold starts reset it).
 * Use a shared store (Upstash/Redis) if you need strict enforcement.
 */
export const IP_LIMITS = {
  caller: () => ({ limit: envInt("RATE_LIMIT_CALLER_MAX", 30), windowMs: envInt("RATE_LIMIT_CALLER_WINDOW_SEC", 300) * 1000 }),
  grading: () => ({ limit: envInt("RATE_LIMIT_GRADING_MAX", 10), windowMs: envInt("RATE_LIMIT_GRADING_WINDOW_SEC", 3600) * 1000 }),
  token: () => ({ limit: envInt("RATE_LIMIT_TOKEN_MAX", 10), windowMs: envInt("RATE_LIMIT_TOKEN_WINDOW_SEC", 3600) * 1000 }),
  access: () => ({ limit: 10, windowMs: 15 * 60_000 }),
} as const;

/** Returns a 429 Response (with Retry-After) when the IP is over its limit, else null. */
export function ipLimitResponse(req: Request, scope: keyof typeof IP_LIMITS): Response | null {
  const cfg = IP_LIMITS[scope]();
  const r = rateLimit({ key: `ip:${scope}:${clientIp(req)}`, ...cfg });
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  return Response.json(
    { error: "rate_limited", message: `You're going a bit fast. Please wait ${formatWait(retryAfter)} and try again.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

function formatWait(sec: number): string {
  if (sec < 90) return `${sec} seconds`;
  const m = Math.ceil(sec / 60);
  return m < 90 ? `${m} minutes` : `${Math.ceil(m / 60)} hours`;
}

export const MAX_BODY_BYTES = 200_000;
export const MAX_TURNS = 200;
export const MAX_TRANSCRIPT_CHARS = 20_000;

/** Reads a JSON body, rejecting anything over MAX_BODY_BYTES. Throws on oversize/invalid. */
export async function readJsonLimited(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("too_large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("too_large");
  return JSON.parse(text);
}

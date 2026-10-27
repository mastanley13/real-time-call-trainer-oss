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

// Keys that never come back (one-off IPs, old accounts) would otherwise stay in
// the Map for the life of the process, so expired buckets are swept periodically.
const SWEEP_EVERY = 500;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
}

/** Live bucket count, for tests and diagnostics. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

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
  if (++callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }
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

/**
 * The caller's IP, for rate limits and audit rows. Proxies (nginx's
 * proxy_add_x_forwarded_for, Fly, Render) append the address they saw to
 * X-Forwarded-For, so only the last TRUSTED_PROXY_HOPS entries come from
 * infrastructure we trust; anything to their left is whatever the client sent.
 * Vercel overwrites the header with a single entry, which the default of 1 reads.
 * x-real-ip is read only without X-Forwarded-For, since some hosts pass a
 * client-sent copy through untouched.
 */
export function clientIp(req: Request): string {
  const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = entries.length
    ? entries[Math.max(0, entries.length - envInt("TRUSTED_PROXY_HOPS", 1))]
    : req.headers.get("x-real-ip")?.trim();
  // Bounded because the value lands in bucket keys and audit rows.
  return ip ? ip.slice(0, 64) : "unknown";
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
  /** OpenAI Realtime client secrets: one per voice call. */
  realtime: () => ({ limit: envInt("RATE_LIMIT_REALTIME_MAX", 10), windowMs: envInt("RATE_LIMIT_REALTIME_WINDOW_SEC", 3600) * 1000 }),
  access: () => ({ limit: 10, windowMs: 15 * 60_000 }),
  /** Live coach: one call per finished turn, so this is much looser than grading. */
  coach: () => ({ limit: envInt("RATE_LIMIT_COACH_MAX", 120), windowMs: envInt("RATE_LIMIT_COACH_WINDOW_SEC", 600) * 1000 }),
  /** Persona wizard: generation and URL fetching. */
  wizard: () => ({ limit: envInt("RATE_LIMIT_WIZARD_MAX", 20), windowMs: envInt("RATE_LIMIT_WIZARD_WINDOW_SEC", 3600) * 1000 }),
} as const;

/**
 * Per-account limits next to the IP ones, so a signed-in user can't get past
 * them by switching networks. Fixed, not env-tunable: they cap one person.
 */
export const USER_LIMITS = {
  /** Shared by /api/persona/generate and /api/persona/fetch-url. */
  wizard: { limit: 20, windowMs: 3_600_000 },
} as const;

function limitedResponse(r: RateLimitResult): Response | null {
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  return Response.json(
    { error: "rate_limited", message: `You're going a bit fast. Please wait ${formatWait(retryAfter)} and try again.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Returns a 429 Response (with Retry-After) when the IP is over its limit, else null. */
export function ipLimitResponse(req: Request, scope: keyof typeof IP_LIMITS): Response | null {
  return limitedResponse(rateLimit({ key: `ip:${scope}:${clientIp(req)}`, ...IP_LIMITS[scope]() }));
}

/** Same 429 shape as ipLimitResponse, keyed on the signed-in user (`<scope>:<userId>`). */
export function userLimitResponse(userId: string, scope: keyof typeof USER_LIMITS): Response | null {
  return limitedResponse(rateLimit({ key: `${scope}:${userId}`, ...USER_LIMITS[scope] }));
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

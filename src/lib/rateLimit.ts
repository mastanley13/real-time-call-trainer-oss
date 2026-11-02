/**
 * Rate limiting.
 *
 * `rateLimit` is a fixed-window in-memory limiter: per process, reset on restart.
 * `sharedRateLimit` has the same options and result but keeps its counters in
 * Postgres (the RateLimitBucket table) when the shared store is on, so limits add
 * up across serverless instances and survive cold starts. It falls back to the
 * in-memory limiter when the store is off (local dev, demo mode, no database) or
 * when a database call fails. `ipLimitResponse` and `userLimitResponse` use it.
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
 * Counted in the shared Postgres store in production (see sharedStoreEnabled);
 * in-memory and per instance otherwise.
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
  /** Voice metering: one heartbeat every 10 seconds per call, plus end events and usage reads. */
  usage: () => ({ limit: envInt("RATE_LIMIT_USAGE_MAX", 1200), windowMs: envInt("RATE_LIMIT_USAGE_WINDOW_SEC", 600) * 1000 }),
  /** Stripe Checkout and Billing Portal sessions. */
  billing: () => ({ limit: envInt("RATE_LIMIT_BILLING_MAX", 20), windowMs: envInt("RATE_LIMIT_BILLING_WINDOW_SEC", 3600) * 1000 }),
} as const;

/**
 * Per-account limits next to the IP ones, so a signed-in user can't get past
 * them by switching networks. Fixed, not env-tunable: they cap one person.
 */
export const USER_LIMITS = {
  /** Shared by /api/persona/generate and /api/persona/fetch-url. */
  wizard: { limit: 20, windowMs: 3_600_000 },
  /** Heartbeats (6 a minute per call), end events and usage reads. */
  usage: { limit: 60, windowMs: 60_000 },
  /** Checkout and portal sessions. */
  billing: { limit: 20, windowMs: 3_600_000 },
} as const;

/**
 * Whether limits are kept in Postgres. RATE_LIMIT_STORE=postgres forces it on and
 * RATE_LIMIT_STORE=memory forces it off. Unset, it is on in production with a
 * DATABASE_URL and off everywhere else, so local dev and demo mode need no database.
 */
export function sharedStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const store = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (store === "memory") return false;
  if (env.DEMO_MODE === "true" || !env.DATABASE_URL) return false;
  return store === "postgres" || env.NODE_ENV === "production";
}

/** The one query the shared store needs, so tests can swap in a fake. */
export interface SharedBucketStore {
  /** Counts one hit on `key` and returns the bucket after it; opens a new window when the old one has ended. */
  hit(key: string, now: Date, resetAt: Date): Promise<{ count: number; resetAt: Date }>;
  /** Deletes buckets whose window ended before `before`. */
  prune(before: Date): Promise<void>;
}

/** Postgres store: one atomic upsert per hit, so concurrent instances can't both take the last slot. */
const postgresStore: SharedBucketStore = {
  async hit(key, now, resetAt) {
    const { prisma } = await import("@/lib/db");
    const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
      INSERT INTO "RateLimitBucket" ("key", "count", "resetAt") VALUES (${key}, 1, ${resetAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN EXCLUDED."resetAt" ELSE "RateLimitBucket"."resetAt" END
      RETURNING "count", "resetAt"`;
    const row = rows[0];
    if (!row) throw new Error("rate limit upsert returned no row");
    return { count: Number(row.count), resetAt: new Date(row.resetAt) };
  },
  async prune(before) {
    const { prisma } = await import("@/lib/db");
    await prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "resetAt" < ${before}`;
  },
};

let store: SharedBucketStore = postgresStore;

/** Test hook: swap the shared store (pass nothing to restore Postgres). */
export function setSharedBucketStore(next?: SharedBucketStore): void {
  store = next ?? postgresStore;
}

// Old buckets are deleted every PRUNE_EVERY shared hits per instance, an hour after their window ends.
const PRUNE_EVERY = 1_000;
const PRUNE_GRACE_MS = 3_600_000;
let hitsSincePrune = 0;
let warned = false;

/**
 * Same options and result as `rateLimit`, counted in the shared store when it is on.
 * A store error falls back to the in-memory limiter for that request (logged once per
 * instance), so a database blip degrades limits to best-effort instead of taking routes down.
 */
export async function sharedRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  if (!sharedStoreEnabled()) return rateLimit(opts);
  const nowMs = Date.now();
  try {
    const bucket = await store.hit(opts.key, new Date(nowMs), new Date(nowMs + opts.windowMs));
    if (++hitsSincePrune >= PRUNE_EVERY) {
      hitsSincePrune = 0;
      store.prune(new Date(nowMs - PRUNE_GRACE_MS)).catch(() => {});
    }
    if (bucket.count > opts.limit) return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, bucket.resetAt.getTime() - nowMs) };
    return { allowed: true, remaining: opts.limit - bucket.count, retryAfterMs: 0 };
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error("[rateLimit] shared store failed, using in-memory limits on this instance:", err instanceof Error ? err.message : err);
    }
    return rateLimit(opts);
  }
}

function limitedResponse(r: RateLimitResult): Response | null {
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  return Response.json(
    { error: "rate_limited", message: `You're going a bit fast. Please wait ${formatWait(retryAfter)} and try again.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Resolves to a 429 Response (with Retry-After) when the IP is over its limit, else null. Uses the shared store. */
export async function ipLimitResponse(req: Request, scope: keyof typeof IP_LIMITS): Promise<Response | null> {
  return limitedResponse(await sharedRateLimit({ key: `ip:${scope}:${clientIp(req)}`, ...IP_LIMITS[scope]() }));
}

/** Same 429 shape as ipLimitResponse, keyed on the signed-in user (`<scope>:<userId>`). Uses the shared store. */
export async function userLimitResponse(userId: string, scope: keyof typeof USER_LIMITS): Promise<Response | null> {
  return limitedResponse(await sharedRateLimit({ key: `${scope}:${userId}`, ...USER_LIMITS[scope] }));
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

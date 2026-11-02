import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  rateLimit,
  setSharedBucketStore,
  sharedRateLimit,
  sharedStoreEnabled,
  ipLimitResponse,
  type SharedBucketStore,
} from "@/lib/rateLimit";
import { POST as access } from "@/app/api/access/route";

/**
 * A stand-in for the Postgres upsert with the same semantics: one counter per key, a new
 * window once the old one has ended. Two "instances" share it the way two serverless
 * instances share the RateLimitBucket table.
 */
function fakeStore() {
  const rows = new Map<string, { count: number; resetAt: Date }>();
  const store: SharedBucketStore & { rows: typeof rows; hits: number; pruned: Date[] } = {
    rows,
    hits: 0,
    pruned: [],
    async hit(key, now, resetAt) {
      store.hits++;
      const row = rows.get(key);
      const next = !row || row.resetAt <= now ? { count: 1, resetAt } : { count: row.count + 1, resetAt: row.resetAt };
      rows.set(key, next);
      return { ...next };
    },
    async prune(before) {
      store.pruned.push(before);
      for (const [k, r] of rows) if (r.resetAt < before) rows.delete(k);
    },
  };
  return store;
}

const prodEnv = () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_STORE", "");
};

let n = 0;
const key = () => `shared-test:${++n}`;

afterEach(() => {
  setSharedBucketStore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sharedStoreEnabled", () => {
  const db = "postgresql://x";
  it.each([
    [{ NODE_ENV: "production", DATABASE_URL: db }, true],
    [{ NODE_ENV: "development", DATABASE_URL: db }, false],
    [{ NODE_ENV: "development", DATABASE_URL: db, RATE_LIMIT_STORE: "postgres" }, true],
    [{ NODE_ENV: "production", DATABASE_URL: db, RATE_LIMIT_STORE: "memory" }, false],
    [{ NODE_ENV: "production", DATABASE_URL: db, RATE_LIMIT_STORE: " Memory " }, false],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", DATABASE_URL: db, DEMO_MODE: "true" }, false],
    [{ NODE_ENV: "development", RATE_LIMIT_STORE: "postgres" }, false],
  ])("%j -> %s", (env, expected) => {
    expect(sharedStoreEnabled(env as unknown as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("sharedRateLimit", () => {
  it("uses the in-memory limiter when the shared store is off", async () => {
    const store = fakeStore();
    setSharedBucketStore(store);
    vi.stubEnv("RATE_LIMIT_STORE", "memory");
    const k = key();
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await sharedRateLimit({ key: k, limit: 2, windowMs: 60_000 }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(store.hits).toBe(0);
  });

  it("counts in the shared store, so the limit holds across instances and restarts", async () => {
    prodEnv();
    const store = fakeStore();
    setSharedBucketStore(store);
    const k = key();
    const opts = { key: k, limit: 3, windowMs: 60_000 };
    // Only the shared row decides, whichever instance takes the call.
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await sharedRateLimit(opts));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3].retryAfterMs).toBeGreaterThan(0);
    expect(results[3].retryAfterMs).toBeLessThanOrEqual(60_000);
    // The in-memory buckets never saw this key.
    expect(rateLimit({ key: k, limit: 1, windowMs: 60_000 }).allowed).toBe(true);
  });

  it("opens a new window after the old one ends", async () => {
    prodEnv();
    setSharedBucketStore(fakeStore());
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const opts = { key: key(), limit: 1, windowMs: 10_000 };
    expect((await sharedRateLimit(opts)).allowed).toBe(true);
    const blocked = await sharedRateLimit(opts);
    expect(blocked).toEqual({ allowed: false, remaining: 0, retryAfterMs: 10_000 });
    vi.setSystemTime(1_010_000);
    expect((await sharedRateLimit(opts)).allowed).toBe(true);
  });

  it("falls back to in-memory limits when the store fails, and logs once", async () => {
    prodEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setSharedBucketStore({
      hit: () => Promise.reject(new Error("db down")),
      prune: () => Promise.resolve(),
    });
    const opts = { key: key(), limit: 2, windowMs: 60_000 };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await sharedRateLimit(opts));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(error.mock.calls.filter((c) => String(c[0]).includes("[rateLimit]")).length).toBeLessThanOrEqual(1);
  });

  it("prunes expired buckets now and then, an hour after their window", async () => {
    prodEnv();
    const store = fakeStore();
    setSharedBucketStore(store);
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    for (let i = 0; i < 1_000; i++) await sharedRateLimit({ key: key(), limit: 5, windowMs: 1_000 });
    expect(store.pruned.length).toBeGreaterThanOrEqual(1);
    expect(store.pruned.at(-1)!.getTime()).toBeLessThanOrEqual(10_000_000 - 3_600_000);
  });
});

describe("routes on the shared store", () => {
  const req = (ip: string) =>
    new NextRequest("http://localhost/api/access", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ code: "wrong" }),
    });

  it("/api/access counts attempts in the shared store", async () => {
    prodEnv();
    vi.stubEnv("ACCESS_CODE", "right-code-for-tests");
    const store = fakeStore();
    setSharedBucketStore(store);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await access(req("203.0.113.77"))).status);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
    expect(store.rows.get("ip:access:203.0.113.77")?.count).toBe(11);
  });

  it("ipLimitResponse returns the 429 shape from shared counts", async () => {
    prodEnv();
    const store = fakeStore();
    setSharedBucketStore(store);
    store.rows.set("ip:billing:198.51.100.9", { count: 20, resetAt: new Date(Date.now() + 120_000) });
    const res = await ipLimitResponse(new Request("http://localhost/x", { headers: { "x-forwarded-for": "198.51.100.9" } }), "billing");
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("Retry-After"))).toBeGreaterThan(100);
  });
});

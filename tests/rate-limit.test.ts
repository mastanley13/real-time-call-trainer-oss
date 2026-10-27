import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Only the session check is faked; the limiter and the routes' limit wiring run for real.
const mocks = vi.hoisted(() => ({ user: { id: "u-0", email: "rep@example.test" } }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user }));

import { clientIp, ipLimitResponse, USER_LIMITS, userLimitResponse } from "@/lib/rateLimit";
import { POST as fetchUrl } from "@/app/api/persona/fetch-url/route";
import { POST as checkConnection } from "@/app/api/llm/check/route";

const req = (headers: Record<string, string> = {}, url = "http://localhost/api/x", body?: string) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

let n = 0;
/** A fresh account per test, so per-user buckets never leak between tests. */
const signIn = () => (mocks.user = { id: `rl-${++n}`, email: `rl-${n}@example.test` });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("clientIp", () => {
  it("reads Vercel's single-entry header", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("ignores client-sent entries left of the one the proxy appended", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2,, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("counts TRUSTED_PROXY_HOPS from the right", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 10.0.0.2" }))).toBe("198.51.100.4");
    // Fewer entries than hops: the leftmost was still written by a trusted proxy.
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it.each(["0", "-1", "abc", ""])("falls back to one hop for TRUSTED_PROXY_HOPS=%j", (v) => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", v);
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("uses x-real-ip only without X-Forwarded-For, then unknown", () => {
    expect(clientIp(req({ "x-real-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(req({ "x-real-ip": " 192.0.2.9 " }))).toBe("192.0.2.9");
    expect(clientIp(req())).toBe("unknown");
  });

  it("bounds the value written to bucket keys and audit rows", () => {
    expect(clientIp(req({ "x-forwarded-for": "a".repeat(500) }))).toHaveLength(64);
  });
});

describe("ipLimitResponse", () => {
  it("can't be skipped by rotating a spoofed first entry", () => {
    const codes: (number | null)[] = [];
    for (let i = 0; i < 11; i++) codes.push(ipLimitResponse(req({ "x-forwarded-for": `9.9.9.${i}, 203.0.113.50` }), "access")?.status ?? null);
    expect(codes.slice(0, 10).every((c) => c === null)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("userLimitResponse", () => {
  it("allows the wizard limit per account, then returns the shared 429 shape", async () => {
    const { id } = signIn();
    for (let i = 0; i < USER_LIMITS.wizard.limit; i++) expect(userLimitResponse(id, "wizard")).toBeNull();
    const res = userLimitResponse(id, "wizard")!;
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/Please wait \d+ minutes and try again\./), retryAfter: expect.any(Number) });
    expect(userLimitResponse(signIn().id, "wizard")).toBeNull();
  });
});

describe("rateLimit bucket sweep", () => {
  it("drops expired buckets and keeps live ones", async () => {
    vi.resetModules();
    const rl = await import("@/lib/rateLimit");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let i = 0; i < 100; i++) rl.rateLimit({ key: `old:${i}`, limit: 5, windowMs: 1_000 });
    rl.rateLimit({ key: "busy", limit: 1, windowMs: 60_000 });
    expect(rl.rateLimitBucketCount()).toBe(101);

    vi.setSystemTime(2_000);
    for (let i = 0; i < 500; i++) rl.rateLimit({ key: "live", limit: 1_000, windowMs: 60_000 });
    expect(rl.rateLimitBucketCount()).toBe(2);
    expect(rl.rateLimit({ key: "busy", limit: 1, windowMs: 60_000 }).allowed).toBe(false);
  });
});

describe("routes with per-user limits", () => {
  it("persona fetch-url limits one account across many IPs", async () => {
    signIn();
    const codes: number[] = [];
    for (let i = 0; i <= USER_LIMITS.wizard.limit; i++) {
      codes.push((await fetchUrl(req({ "x-forwarded-for": `198.51.100.${i}` }, "http://localhost/api/persona/fetch-url", "{}"))).status);
    }
    // The body is invalid, so allowed calls stop at 400 before any fetch.
    expect(codes.slice(0, -1).every((c) => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("llm/check limits one account across many IPs", async () => {
    // No key, so allowed checks answer "no_key" without calling a provider.
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    signIn();
    const check = (ip: string) => checkConnection(req({ "x-forwarded-for": ip }, "http://localhost/api/llm/check"));
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await check(`192.0.2.${i}`)).status);
    expect(codes.every((c) => c === 200)).toBe(true);
    const last = await check("192.0.2.200");
    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/20 times in the last hour\. Wait 60 minutes/) });
  });
});

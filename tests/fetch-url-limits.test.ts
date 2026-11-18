import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/persona/fetch-url must 429 before it fetches. Per-account coverage in
 * rate-limit.test.ts uses an invalid body, so it never proves fetchPublicPage stayed idle.
 * This file covers the IP cap and the per-account cap with a valid URL.
 * The session check and fetchPublicPage are the only fakes.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "u-0", email: "rep@example.test" },
  fetchPublicPage: vi.fn(),
}));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));
vi.mock("@/lib/safeFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safeFetch")>()),
  fetchPublicPage: mocks.fetchPublicPage,
}));

import { POST as fetchUrl } from "@/app/api/persona/fetch-url/route";
import { USER_LIMITS } from "@/lib/rateLimit";

const PAGE = { url: "https://example.test/product", title: "Example", text: "Hello", bytes: 5 };
const URL_BODY = { url: "https://example.test/product" };

let users = 0;
let ips = 0;
const signIn = () => (mocks.user = { id: `fetch-${++users}`, email: `fetch-${users}@example.test` });
const ip = () => `198.18.61.${(++ips % 250) + 1}`;

function post(body: unknown, from = ip()) {
  return fetchUrl(new NextRequest("http://localhost/api/persona/fetch-url", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  signIn();
  mocks.fetchPublicPage.mockReset();
  mocks.fetchPublicPage.mockResolvedValue(PAGE);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_WIZARD_MAX", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/persona/fetch-url rate limits", () => {
  it("limits one IP across accounts, then 429s with Retry-After before fetching", async () => {
    vi.stubEnv("RATE_LIMIT_WIZARD_MAX", "2");
    const from = ip();
    expect((await post(URL_BODY, from)).status).toBe(200);
    signIn();
    expect((await post(URL_BODY, from)).status).toBe(200);
    signIn();
    const limited = await post(URL_BODY, from);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(mocks.fetchPublicPage).toHaveBeenCalledTimes(2);

    signIn();
    expect((await post(URL_BODY)).status).toBe(200);
    expect(mocks.fetchPublicPage).toHaveBeenCalledTimes(3);
  });

  it("limits one account across IPs at 20 fetches an hour, and never fetches the extra call", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= USER_LIMITS.wizard.limit; i++) {
      codes.push((await post(URL_BODY)).status);
    }
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    const limited = codes.length;
    expect(limited).toBe(USER_LIMITS.wizard.limit + 1);
    expect(mocks.fetchPublicPage).toHaveBeenCalledTimes(USER_LIMITS.wizard.limit);
    expect(mocks.fetchPublicPage).toHaveBeenCalledWith("https://example.test/product");

    signIn();
    const other = await post(URL_BODY);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual(PAGE);
    expect(mocks.fetchPublicPage).toHaveBeenCalledTimes(USER_LIMITS.wizard.limit + 1);
  });
});

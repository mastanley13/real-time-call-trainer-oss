import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the rate limiter are the only fakes; the route and the access helpers run for real.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), rateLimit: mocks.rateLimit }));

import { POST } from "@/app/api/auth/register/route";
import { ACCESS_COOKIE, accessToken } from "@/lib/access";

const CODE = "let-me-in";
const body = {
  firstName: "Mia",
  lastName: "Chen",
  email: "mia@example.test",
  password: "correct-horse-battery",
  newOrgName: "Example Team",
};

const post = (cookie?: string) =>
  POST(new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `${ACCESS_COOKIE}=${cookie}` } : {}) },
  }));

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-only-secret-0123456789abcdef");
  vi.stubEnv("TRAINER_ACCESS_CODE", "");
  mocks.rateLimit.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mocks.prisma.user.findUnique.mockReset().mockResolvedValue({ id: "u-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/register access gate", () => {
  it("returns 403 when the gate is set and there is no cookie", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite code required" });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when the cookie is wrong", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post("not-the-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite code required" });
  });

  it("proceeds when the cookie is valid", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post(await accessToken(CODE));
    expect(res.status).toBe(409);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledOnce();
  });

  it("proceeds without a cookie when the gate is unset", async () => {
    const res = await post();
    expect(res.status).toBe(409);
  });
});

describe("POST /api/auth/register database failures", () => {
  it("returns a JSON 500 when the email lookup throws", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Registration failed. Please try again." });
  });
});

describe("POST /api/auth/register sign-up intent", () => {
  const created = vi.fn();
  const joinOrg = vi.fn();
  const { newOrgName: _omit, ...joinBase } = body;

  beforeEach(() => {
    created.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "u-new", email: data.email, firstName: data.firstName, lastName: data.lastName, role: data.role, isPlatformAdmin: false,
      organization: { id: "org-1", name: "Example Team", code: "123456" },
    }));
    joinOrg.mockReset().mockResolvedValue({ id: "org-9", code: "654321" });
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    (mocks.prisma as Record<string, unknown>).organization = { findUnique: vi.fn().mockResolvedValue(null) };
    mocks.prisma.$transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        organization: { create: vi.fn().mockResolvedValue({ id: "org-1" }), findUnique: joinOrg },
        user: { create: created },
        auditEvent: { create: vi.fn() },
      }));
  });

  const register = (extra: Record<string, unknown>, base: Record<string, unknown> = body) =>
    POST(new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...base, ...extra }),
      headers: { "content-type": "application/json" },
    }));
  const stored = () => (created.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it("stores plan, interval, src and seg on the new user", async () => {
    const res = await register({ plan: "team", interval: "year", src: "pricing", seg: "insurance" });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ signupPlanIntent: "team", signupInterval: "year", signupSrc: "pricing", signupSeg: "insurance" });
  });

  it("drops bad values instead of storing them, and still registers", async () => {
    const res = await register({ plan: "enterprise", interval: "week", src: "<script>x</script>", seg: "a".repeat(500) });
    expect(res.status).toBe(200);
    expect(stored().signupPlanIntent).toBeUndefined();
    expect(stored().signupInterval).toBeUndefined();
    expect(stored().signupSrc).toBeUndefined();
    expect(stored().signupSeg).toBeUndefined();
  });

  it("stores nothing when the body has no intent", async () => {
    await register({});
    expect(stored().signupPlanIntent).toBeUndefined();
    expect(stored().signupSrc).toBeUndefined();
  });

  it("keeps the org rules: exactly one of joinOrgCode and newOrgName", async () => {
    const both = await register({ joinOrgCode: "123456", plan: "pro" });
    expect(both.status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });

  it("an unknown join code is still a 400", async () => {
    joinOrg.mockResolvedValue(null);
    const res = await register({ joinOrgCode: "654321", plan: "pro" }, joinBase);
    expect(res.status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });

  it("a join with intent creates a trainee that carries the intent", async () => {
    const res = await register({ joinOrgCode: "654321", plan: "pro", src: "pricing" }, joinBase);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ role: "trainee", signupPlanIntent: "pro", signupSrc: "pricing" });
  });
});

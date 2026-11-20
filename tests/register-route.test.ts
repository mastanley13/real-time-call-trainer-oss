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

  it("never overwrites intent: a repeat sign-up for an existing email is a 409 with no write", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "u-1", signupPlanIntent: "pro", signupSrc: "pricing" });
    const res = await register({ plan: "team", interval: "year", src: "other", seg: "other" });
    expect(res.status).toBe(409);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it("a join with intent creates a trainee that carries the intent", async () => {
    const res = await register({ joinOrgCode: "654321", plan: "pro", src: "pricing" }, joinBase);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ role: "trainee", signupPlanIntent: "pro", signupSrc: "pricing" });
  });
});

describe("POST /api/auth/register team-code join", () => {
  const created = vi.fn();
  const joinOrg = vi.fn();
  const createOrg = vi.fn();
  const { newOrgName: _omit, ...joinBase } = body;

  beforeEach(() => {
    created.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `u-${String(data.email)}`,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role,
      isPlatformAdmin: false,
      organization: { id: data.organizationId, name: "Harbor Point", code: "654321" },
    }));
    joinOrg.mockReset().mockResolvedValue({ id: "org-9", code: "654321", createdAt: new Date("2019-03-01T00:00:00.000Z") });
    createOrg.mockReset().mockResolvedValue({ id: "org-new", code: "111222" });
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    (mocks.prisma as Record<string, unknown>).organization = { findUnique: vi.fn().mockResolvedValue(null) };
    mocks.prisma.$transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        organization: { create: createOrg, findUnique: joinOrg },
        user: { create: created },
        auditEvent: { create: vi.fn() },
      }));
  });

  const register = (extra: Record<string, unknown>, base: Record<string, unknown> = joinBase) =>
    POST(new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...base, ...extra }),
      headers: { "content-type": "application/json" },
    }));
  const stored = (n = 0) => (created.mock.calls[n][0] as { data: Record<string, unknown> }).data;

  it("looks the team up by code only, so an old standing code still works (codes do not expire)", async () => {
    const res = await register({ joinOrgCode: "654321" });
    expect(res.status).toBe(200);
    expect(joinOrg).toHaveBeenCalledWith({ where: { code: "654321" } });
    expect(createOrg).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ role: "trainee", organizationId: "org-9" });
  });

  it("lets a second person reuse the same team code, each as a trainee", async () => {
    const first = await register({ joinOrgCode: "654321" }, { ...joinBase, email: "ravi@example.test" });
    const second = await register({ joinOrgCode: "654321" }, { ...joinBase, email: "ana@example.test" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(created).toHaveBeenCalledTimes(2);
    expect(stored(0)).toMatchObject({ email: "ravi@example.test", role: "trainee", organizationId: "org-9" });
    expect(stored(1)).toMatchObject({ email: "ana@example.test", role: "trainee", organizationId: "org-9" });
    expect(createOrg).not.toHaveBeenCalled();
  });

  it("a join is always a trainee: a body that also sends owner or admin flags cannot mint an admin", async () => {
    const res = await register({ joinOrgCode: "654321", role: "owner", isPlatformAdmin: true });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ role: "trainee", organizationId: "org-9" });
    expect(stored()).not.toHaveProperty("isPlatformAdmin");
    const json = await res.json() as { user: { role: string; isPlatformAdmin: boolean } };
    expect(json.user).toMatchObject({ role: "trainee", isPlatformAdmin: false });
  });

  it("creating a team is an owner; joining never creates a team", async () => {
    const createdTeam = await POST(new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }));
    expect(createdTeam.status).toBe(200);
    expect(stored()).toMatchObject({ role: "owner" });
    expect(createOrg).toHaveBeenCalledOnce();

    created.mockClear();
    createOrg.mockClear();
    joinOrg.mockClear();
    const joined = await register({ joinOrgCode: "654321" });
    expect(joined.status).toBe(200);
    expect(stored()).toMatchObject({ role: "trainee" });
    expect(createOrg).not.toHaveBeenCalled();
  });

  it("rejects a code that is not 3 to 8 digits before touching the database", async () => {
    for (const joinOrgCode of ["12", "123456789", "abc", "12345a", "1234-56"]) {
      created.mockClear();
      joinOrg.mockClear();
      const res = await register({ joinOrgCode });
      expect(res.status, joinOrgCode).toBe(400);
      expect(created).not.toHaveBeenCalled();
      expect(joinOrg).not.toHaveBeenCalled();
    }
  });
});

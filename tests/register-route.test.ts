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

  it("lets a second person reuse the same team code, each as a trainee", async () => {
    const first = await register({ joinOrgCode: "654321", plan: "pro" }, { ...joinBase, email: "ravi@example.test" });
    const second = await register({ joinOrgCode: "654321", plan: "pro" }, { ...joinBase, email: "ana@example.test" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(created).toHaveBeenCalledTimes(2);
    expect(stored()).toMatchObject({ email: "ravi@example.test", role: "trainee", organizationId: "org-9" });
    const secondStored = (created.mock.calls[1][0] as { data: Record<string, unknown> }).data;
    expect(secondStored).toMatchObject({ email: "ana@example.test", role: "trainee", organizationId: "org-9" });
  });

  it("a join is always a trainee: a body that also sends owner or admin flags cannot mint an admin", async () => {
    const res = await register({ joinOrgCode: "654321", role: "owner", isPlatformAdmin: true }, joinBase);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ role: "trainee", organizationId: "org-9" });
    expect(stored()).not.toHaveProperty("isPlatformAdmin");
    const json = await res.json() as { user: { role: string; isPlatformAdmin: boolean } };
    expect(json.user).toMatchObject({ role: "trainee", isPlatformAdmin: false });
  });
});

describe("POST /api/auth/register team name is optional", () => {
  const orgCreate = vi.fn();
  const userCreate = vi.fn();
  const joinOrg = vi.fn();
  const { newOrgName: _omit, ...soloBase } = body;

  beforeEach(() => {
    orgCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "org-1", ...data }));
    userCreate.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "u-new", email: data.email, firstName: data.firstName, lastName: data.lastName, role: data.role, isPlatformAdmin: false,
      organization: { id: data.organizationId, name: "stored", code: "123456" },
    }));
    joinOrg.mockReset().mockResolvedValue({ id: "org-9", code: "654321" });
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    (mocks.prisma as Record<string, unknown>).organization = { findUnique: vi.fn().mockResolvedValue(null) };
    mocks.prisma.$transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ organization: { create: orgCreate, findUnique: joinOrg }, user: { create: userCreate }, auditEvent: { create: vi.fn() } }));
  });

  const register = (payload: Record<string, unknown>) =>
    POST(new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    }));
  const orgName = () => (orgCreate.mock.calls[0][0] as { data: { name: string } }).data.name;
  const userData = () => (userCreate.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it("with no team name and no code, creates \"<First>'s workspace\" with the rep as owner", async () => {
    const res = await register(soloBase);
    expect(res.status).toBe(200);
    expect(orgCreate).toHaveBeenCalledOnce();
    expect(orgName()).toBe("Mia's workspace");
    expect(userData()).toMatchObject({ role: "owner", organizationId: "org-1" });
    expect(joinOrg).not.toHaveBeenCalled();
  });

  it("uses the trimmed first name", async () => {
    const res = await register({ ...soloBase, firstName: "  Mia  " });
    expect(res.status).toBe(200);
    expect(orgName()).toBe("Mia's workspace");
  });

  it.each(["", "   ", "\t \n"])("treats a blank team name (%j) as missing", async (blank) => {
    const res = await register({ ...soloBase, newOrgName: blank });
    expect(res.status).toBe(200);
    expect(orgName()).toBe("Mia's workspace");
  });

  it("keeps a provided team name, trimmed", async () => {
    const res = await register({ ...soloBase, newOrgName: "  Example Team  " });
    expect(res.status).toBe(200);
    expect(orgName()).toBe("Example Team");
  });

  it("still rejects a one-character team name and one over 120 characters", async () => {
    expect((await register({ ...soloBase, newOrgName: "A" })).status).toBe(400);
    expect((await register({ ...soloBase, newOrgName: "a".repeat(121) })).status).toBe(400);
    expect(orgCreate).not.toHaveBeenCalled();
  });

  it("joins by code as before: a trainee in the existing org, no new org", async () => {
    const res = await register({ ...soloBase, joinOrgCode: "654321" });
    expect(res.status).toBe(200);
    expect(joinOrg).toHaveBeenCalledWith({ where: { code: "654321" } });
    expect(orgCreate).not.toHaveBeenCalled();
    expect(userData()).toMatchObject({ role: "trainee", organizationId: "org-9" });
  });

  it("an unknown join code is a 400 and never falls back to a new workspace", async () => {
    joinOrg.mockResolvedValue(null);
    const res = await register({ ...soloBase, joinOrgCode: "654321" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "We couldn't find a team with that join code.",
      fieldErrors: { joinOrgCode: "We couldn't find a team with that join code." },
    });
    expect(orgCreate).not.toHaveBeenCalled();
  });

  it("a team name and a join code together are still a 400", async () => {
    const res = await register({ ...soloBase, newOrgName: "Example Team", joinOrgCode: "654321" });
    expect(res.status).toBe(400);
    expect(orgCreate).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/register validation messages", () => {
  const { newOrgName: _omit, ...soloBase } = body;
  const register = (payload: Record<string, unknown>) =>
    POST(new NextRequest("http://localhost/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    }));
  /** A 400 with one friendly message: no Zod wording and no comma-joined list. */
  const friendly400 = async (res: Response) => {
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; fieldErrors: Record<string, string> };
    expect(json.error).not.toMatch(/String must|Invalid|Required|Expected/);
    // Exactly one of the per-field messages, so never a joined list of several.
    expect(Object.values(json.fieldErrors)).toContain(json.error);
    expect(json.error.match(/\./g)).toHaveLength(1);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    return json;
  };

  it("a blank first name says \"Enter your first name.\"", async () => {
    const json = await friendly400(await register({ ...soloBase, firstName: "   " }));
    expect(json).toEqual({ error: "Enter your first name.", fieldErrors: { firstName: "Enter your first name." } });
    expect(JSON.stringify(json)).not.toContain("String must contain");
  });

  it("a join code with a team name gives the single clear message, even when the team name is also too short", async () => {
    for (const newOrgName of ["Example Team", "A"]) {
      const json = await friendly400(await register({ ...soloBase, joinOrgCode: "654321", newOrgName }));
      expect(json.error).toBe("Choose either a join code or a team name, not both.");
      expect(json.fieldErrors).toEqual({
        joinOrgCode: "Choose either a join code or a team name, not both.",
        newOrgName: "Choose either a join code or a team name, not both.",
      });
    }
  });

  it("reports the conflict even when a missing first name makes Zod skip its own check, first name first", async () => {
    const { firstName: _first, ...noFirstName } = soloBase;
    const json = await friendly400(await register({ ...noFirstName, joinOrgCode: "654321", newOrgName: "Example Team" }));
    expect(json).toEqual({
      error: "Enter your first name.",
      fieldErrors: {
        firstName: "Enter your first name.",
        joinOrgCode: "Choose either a join code or a team name, not both.",
        newOrgName: "Choose either a join code or a team name, not both.",
      },
    });
  });

  it("a bad email says \"Enter a valid email address.\"", async () => {
    const json = await friendly400(await register({ ...soloBase, email: "not-an-email" }));
    expect(json).toEqual({ error: "Enter a valid email address.", fieldErrors: { email: "Enter a valid email address." } });
  });

  it("a bad join code says \"Enter a valid join code.\"", async () => {
    const json = await friendly400(await register({ ...soloBase, joinOrgCode: "12ab" }));
    expect(json).toEqual({ error: "Enter a valid join code.", fieldErrors: { joinOrgCode: "Enter a valid join code." } });
  });

  it("several bad fields give one message for the first and one fieldErrors entry each", async () => {
    const json = await friendly400(await register({ ...soloBase, firstName: "", email: "x", password: "short" }));
    expect(json).toEqual({
      error: "Enter your first name.",
      fieldErrors: {
        firstName: "Enter your first name.",
        email: "Enter a valid email address.",
        password: "Password must be at least 10 characters.",
      },
    });
  });
});

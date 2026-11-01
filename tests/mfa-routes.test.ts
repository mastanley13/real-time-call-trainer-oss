import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the session check are the only fakes; the routes run for real.
const mocks = vi.hoisted(() => ({
  user: { id: "m-1", email: "m-1@example.test" } as { id: string; email: string; mfaEnrollment?: boolean },
  verify: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));
vi.mock("@/lib/mfa", () => ({ verifyTotp: mocks.verify, generateMfaSecret: () => "S", buildProvisioningUri: () => "otpauth://x" }));

import { PUT as setPolicy, GET as getPolicy } from "@/app/api/team/mfa/route";
import { POST as resetMfa } from "@/app/api/team/mfa/reset/route";
import { POST as disableMfa } from "@/app/api/auth/mfa/disable/route";
import { GET as me } from "@/app/api/me/route";

const savedEnv = { DATABASE_URL: process.env.DATABASE_URL, DEMO_MODE: process.env.DEMO_MODE, JWT_SECRET: process.env.JWT_SECRET };
const actor = (over: object = {}) => ({ id: "m-1", role: "manager", isPlatformAdmin: false, organizationId: "o-1", firstName: "Mia", lastName: "Chen", email: "m-1@example.test", mfaEnabled: true, ...over });
const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const put = (body: unknown) => setPolicy(json("/api/team/mfa", "PUT", body));
const reset = (userId: string) => resetMfa(json("/api/team/mfa/reset", "POST", { userId }));

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  process.env.JWT_SECRET = "test-secret-0123456789abcdef0123456789";
  delete process.env.DEMO_MODE;
  mocks.user = { id: "m-1", email: "m-1@example.test" };
  for (const group of Object.values(mocks.prisma)) {
    if (typeof group === "function") group.mockReset();
    else for (const fn of Object.values(group)) fn.mockReset();
  }
  mocks.verify.mockReset().mockReturnValue(true);
  mocks.prisma.$transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
  mocks.prisma.user.findUnique.mockResolvedValue(actor());
  mocks.prisma.organization.findUnique.mockResolvedValue({ planTier: "team", requireMfa: false, mfaGraceEndsAt: null });
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("PUT /api/team/mfa", () => {
  it("turns enforcement on for a Team org and writes an audit entry", async () => {
    const res = await put({ requireMfa: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requireMfa: true, graceEndsAt: null, changed: true });
    expect(mocks.prisma.organization.update).toHaveBeenCalledWith({ where: { id: "o-1" }, data: { requireMfa: true, mfaGraceEndsAt: null } });
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ userId: "m-1", action: "org.mfa_enforcement_enabled", resource: "o-1" });
  });

  it("refuses to enable it for an owner who has not enrolled, without writing", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "owner", mfaEnabled: false }));
    const res = await put({ requireMfa: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "mfa_enroll_first", message: "Set up two-factor sign-in for your own account before requiring it for your team." });
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("lets an enrolled owner enable it", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "owner", mfaEnabled: true }));
    expect((await put({ requireMfa: true })).status).toBe(200);
    expect(mocks.prisma.organization.update).toHaveBeenCalled();
  });

  it("lets an unenrolled owner turn it off", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "owner", mfaEnabled: false }));
    mocks.prisma.organization.findUnique.mockResolvedValue({ planTier: "team", requireMfa: true, mfaGraceEndsAt: null });
    const res = await put({ requireMfa: false });
    expect(res.status).toBe(200);
    expect(mocks.prisma.organization.update).toHaveBeenCalledWith({ where: { id: "o-1" }, data: { requireMfa: false, mfaGraceEndsAt: null } });
  });

  it("starts a grace period only when asked", async () => {
    const res = await put({ requireMfa: true, graceDays: 7 });
    expect(res.status).toBe(200);
    const data = mocks.prisma.organization.update.mock.calls[0][0].data;
    expect(data.mfaGraceEndsAt).toBeInstanceOf(Date);
    expect(data.mfaGraceEndsAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  });

  it("refuses to enable it outside the Team plan, without writing", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ planTier: "free", requireMfa: false, mfaGraceEndsAt: null });
    const res = await put({ requireMfa: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "plan_required" });
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("lets a non-Team org turn it off and audits that", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ planTier: "free", requireMfa: true, mfaGraceEndsAt: null });
    const res = await put({ requireMfa: false });
    expect(res.status).toBe(200);
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data.action).toBe("org.mfa_enforcement_disabled");
  });

  it("refuses trainees and rejects bad bodies", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "trainee" }));
    expect((await put({ requireMfa: true })).status).toBe(403);
    mocks.prisma.user.findUnique.mockResolvedValue(actor());
    expect((await put({ requireMfa: "yes" })).status).toBe(400);
    expect((await put({ requireMfa: true, graceDays: 999 })).status).toBe(400);
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/team/mfa", () => {
  it("lists each member's MFA status for managers only", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ planTier: "team", requireMfa: true, mfaGraceEndsAt: null });
    mocks.prisma.user.findMany.mockResolvedValue([
      { id: "m-1", firstName: "Mia", lastName: "Chen", email: "m-1@example.test", role: "manager", mfaEnabled: true, mfaEnrolledAt: new Date() },
      { id: "r-1", firstName: "Ravi", lastName: "Shah", email: "r-1@example.test", role: "trainee", mfaEnabled: false, mfaEnrolledAt: null },
    ]);
    const body = await (await getPolicy(new NextRequest("http://localhost/api/team/mfa"))).json();
    expect(body.canEnforce).toBe(true);
    expect(body.members.map((m: { id: string; state: string }) => [m.id, m.state])).toEqual([["m-1", "compliant"], ["r-1", "enroll_required"]]);

    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "trainee" }));
    expect((await getPolicy(new NextRequest("http://localhost/api/team/mfa"))).status).toBe(403);
  });
});

describe("POST /api/team/mfa/reset", () => {
  const target = (role = "trainee") => ({ id: "r-1", role, mfaEnabled: true, mfaSecret: "S" });

  it("clears the member's MFA and audits it", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue(target());
    const res = await reset("r-1");
    expect(res.status).toBe(200);
    expect(mocks.prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r-1", organizationId: "o-1" } }));
    expect(mocks.prisma.user.update).toHaveBeenCalledWith({ where: { id: "r-1" }, data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null } });
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ userId: "m-1", action: "user.mfa_reset", resource: "r-1" });
  });

  it("stays inside the actor's organization", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue(null);
    expect((await reset("other-org-user")).status).toBe(404);
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps managers from resetting owners, and anyone from resetting themselves", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue(target("owner"));
    expect((await reset("r-1")).status).toBe(403);
    expect((await reset("m-1")).status).toBe(400);
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "owner" }));
    expect((await reset("r-1")).status).toBe(200);
  });

  it("refuses trainees", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ role: "trainee" }));
    expect((await reset("r-1")).status).toBe(403);
  });
});

describe("per-IP limits on the team MFA writes", () => {
  const from = (ip: string, url: string, method: string, body: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "x-forwarded-for": ip } });
  const as = (id: string) => (mocks.user = { id, email: `${id}@example.test` });

  afterEach(() => vi.unstubAllEnvs());

  it("shares the PUT allowance across users on one IP", async () => {
    vi.stubEnv("RATE_LIMIT_TEAM_MFA_POLICY_MAX", "2");
    const codes: number[] = [];
    for (const id of ["ip-put-a", "ip-put-b", "ip-put-c"]) {
      as(id);
      mocks.prisma.user.findUnique.mockResolvedValue(actor({ id }));
      codes.push((await setPolicy(from("203.0.113.61", "/api/team/mfa", "PUT", { requireMfa: false }))).status);
    }
    expect(codes).toEqual([200, 200, 429]);
    as("ip-put-d");
    mocks.prisma.user.findUnique.mockResolvedValue(actor({ id: "ip-put-d" }));
    expect((await setPolicy(from("203.0.113.62", "/api/team/mfa", "PUT", { requireMfa: false }))).status).toBe(200);
  });

  it("shares the reset allowance across users on one IP", async () => {
    vi.stubEnv("RATE_LIMIT_TEAM_MFA_RESET_MAX", "2");
    mocks.prisma.user.findFirst.mockResolvedValue({ id: "r-1", role: "trainee", mfaEnabled: true, mfaSecret: "S" });
    const codes: number[] = [];
    for (const id of ["ip-reset-a", "ip-reset-b", "ip-reset-c"]) {
      as(id);
      mocks.prisma.user.findUnique.mockResolvedValue(actor({ id }));
      const res = await resetMfa(from("203.0.113.71", "/api/team/mfa/reset", "POST", { userId: "r-1" }));
      codes.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe("POST /api/auth/mfa/disable", () => {
  const disable = () => disableMfa(json("/api/auth/mfa/disable", "POST", { code: "123456" }));

  it("is blocked while the org requires MFA", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "m-1", mfaEnabled: true, mfaSecret: "S", organization: { requireMfa: true } });
    const res = await disable();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "mfa_required_by_org" });
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("still works when the org does not require it", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "m-1", mfaEnabled: true, mfaSecret: "S", organization: { requireMfa: false } });
    expect((await disable()).status).toBe(200);
    expect(mocks.prisma.user.update).toHaveBeenCalled();
  });
});

describe("GET /api/me", () => {
  const user = { id: "r-1", email: "r-1@example.test", firstName: "Ravi", lastName: "Shah", role: "trainee", isPlatformAdmin: false, mfaEnabled: false, mfaEnrolledAt: null };
  const withOrg = (org: object) => mocks.prisma.user.findUnique.mockResolvedValue({ ...user, organization: { id: "o-1", name: "Harbor", code: "123", planTier: "team", sessionRetentionDays: null, requireMfa: false, mfaGraceEndsAt: null, ...org } });
  const call = () => me(new NextRequest("http://localhost/api/me"));

  it("reports enroll_required as it happens, and never sets a cookie", async () => {
    withOrg({ requireMfa: true });
    const res = await call();
    expect((await res.json()).mfa).toMatchObject({ state: "enroll_required", requiredByOrg: true });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("reports a grace period", async () => {
    withOrg({ requireMfa: true, mfaGraceEndsAt: new Date(Date.now() + 86_400_000) });
    const body = await (await call()).json();
    expect(body.mfa.state).toBe("grace");
    expect(body.mfa.graceEndsAt).toBeTruthy();
  });

  it("reports not_required as soon as the manager turns the rule off", async () => {
    withOrg({ requireMfa: true });
    expect((await (await call()).json()).mfa.state).toBe("enroll_required");
    withOrg({ requireMfa: false });
    expect((await (await call()).json()).mfa.state).toBe("not_required");
  });
});

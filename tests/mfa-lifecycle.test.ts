import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { hashPassword, verifyMfaChallenge, verifySessionToken } from "@/lib/auth";

const mocks = vi.hoisted(() => ({
  user: { id: "u-mfa", email: "rep@example.test" },
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: () => false,
}));

import { POST as enroll } from "@/app/api/auth/mfa/enroll/route";
import { POST as activate } from "@/app/api/auth/mfa/activate/route";
import { POST as disable } from "@/app/api/auth/mfa/disable/route";
import { POST as login } from "@/app/api/auth/login/route";

const KEY = "test-secret-0123456789abcdef0123456789";
const PASSWORD = "correct-horse-battery";
let passwordHash = "";

type Row = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "owner";
  passwordHash: string | null;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  mfaEnrolledAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  isPlatformAdmin: boolean;
  organizationId: string;
  organization: { id: string; name: string; code: string };
};

let seq = 0;
const ip = () => `10.5.${Math.floor(++seq / 250)}.${seq % 250}`;
let row: Row;

function totp(secret: string) {
  return new OTPAuth.TOTP({
    issuer: "Real-Time Call Trainer",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

function post(path: string, body: unknown, from = ip()) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": from };
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function signIn(id = `u-${++seq}`) {
  mocks.user = { id, email: `${id}@example.test` };
  row = {
    id,
    email: mocks.user.email,
    firstName: "Ravi",
    lastName: "Shah",
    role: "owner",
    passwordHash,
    mfaEnabled: false,
    mfaSecret: null,
    mfaEnrolledAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    isPlatformAdmin: false,
    organizationId: "org-1",
    organization: { id: "org-1", name: "Example Team", code: "329927" },
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
  for (const fn of [mocks.prisma.user.findUnique, mocks.prisma.user.update, mocks.prisma.auditEvent.create]) fn.mockReset();
  mocks.prisma.auditEvent.create.mockResolvedValue({});
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) => {
    if (where.id && where.id === row.id) return { ...row };
    if (where.email && where.email === row.email) return { ...row };
    return null;
  });
  mocks.prisma.user.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    if (where.id !== row.id) throw new Error("Record to update not found.");
    Object.assign(row, data);
    return { ...row };
  });
  signIn();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("MFA enroll, activate and disable", () => {
  it("stores a secret without enabling MFA, then enables only after a valid TOTP", async () => {
    const started = await enroll(post("/api/auth/mfa/enroll", {}));
    expect(started.status).toBe(200);
    const body = await started.json() as { secret: string; provisioningUri: string };
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.provisioningUri).toContain("otpauth://totp/");
    expect(row.mfaSecret).toBe(body.secret);
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaEnrolledAt).toBeNull();

    const good = totp(body.secret);
    const badCode = good === "000000" ? "111111" : "000000";
    const bad = await activate(post("/api/auth/mfa/activate", { code: badCode }));
    expect(bad.status).toBe(401);
    expect(row.mfaEnabled).toBe(false);

    const ok = await activate(post("/api/auth/mfa/activate", { code: good }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ mfaEnabled: true });
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaEnrolledAt).toBeInstanceOf(Date);
  });

  it("refuses a second enroll while MFA is on, and disable needs a valid TOTP", async () => {
    const started = await enroll(post("/api/auth/mfa/enroll", {}));
    const { secret } = await started.json() as { secret: string };
    expect((await activate(post("/api/auth/mfa/activate", { code: totp(secret) }))).status).toBe(200);

    const again = await enroll(post("/api/auth/mfa/enroll", {}));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "MFA is already enabled. Disable it first to re-enroll." });
    expect(row.mfaSecret).toBe(secret);

    const good = totp(secret);
    const wrong = await disable(post("/api/auth/mfa/disable", { code: good === "000000" ? "111111" : "000000" }));
    expect(wrong.status).toBe(401);
    expect(row.mfaEnabled).toBe(true);
    expect(row.mfaSecret).toBe(secret);

    const off = await disable(post("/api/auth/mfa/disable", { code: good }));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ mfaEnabled: false });
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecret).toBeNull();
    expect(row.mfaEnrolledAt).toBeNull();
  });
});

describe("password login with MFA enabled", () => {
  it("returns a challenge and no session cookie, and a wrong password stays generic", async () => {
    const started = await enroll(post("/api/auth/mfa/enroll", {}));
    const { secret } = await started.json() as { secret: string };
    expect((await activate(post("/api/auth/mfa/activate", { code: totp(secret) }))).status).toBe(200);

    const from = ip();
    const challenged = await login(post("/api/auth/login", { email: row.email, password: PASSWORD }, from));
    expect(challenged.status).toBe(200);
    const body = await challenged.json() as { mfaRequired?: boolean; challengeToken?: string; token?: string };
    expect(body.mfaRequired).toBe(true);
    expect(body.token).toBeUndefined();
    expect(challenged.headers.get("set-cookie")).toBeNull();
    expect(verifyMfaChallenge(body.challengeToken ?? "")).toEqual({ id: row.id, linkGoogleSub: undefined });
    expect(verifySessionToken(body.challengeToken ?? "")).toBeNull();

    const denied = await login(post("/api/auth/login", { email: row.email, password: "not-the-password" }, ip()));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Invalid email or password." });
    expect(denied.headers.get("set-cookie")).toBeNull();
  });
});

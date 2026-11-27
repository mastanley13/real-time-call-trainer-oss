import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";

/**
 * /api/auth/mfa/challenge exchanges a short-lived MFA challenge for a session.
 * A session JWT must not complete that step, and the challenge JWT must not
 * work as a session.
 *
 * Replay of a used challenge jti or TOTP step is not asserted here. Main has
 * neither a consumed-challenge table nor mfaLastTotpStep. Those guards live on
 * cursor/mfa-replay-guards-cdee with a Prisma migration and cannot be extracted
 * as tests that pass on current main.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { POST as challenge } from "@/app/api/auth/mfa/challenge/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { signMfaChallengeToken, signSessionToken, verifySessionToken } from "@/lib/auth";
import { stripeApi } from "@/lib/stripe";

const KEY = "test-secret-0123456789abcdef0123456789";
const SECRET = "JBSWY3DPEHPK3PXP";

type Row = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "owner";
  mfaEnabled: boolean;
  mfaSecret: string | null;
  lastLoginAt: Date | null;
  isPlatformAdmin: boolean;
  organization: { id: string; name: string; code: string } | null;
};

let row: Row;
let n = 0;
const ip = () => `198.51.90.${(++n % 250) + 1}`;

function totp(secret = SECRET) {
  return new OTPAuth.TOTP({
    issuer: "Real-Time Call Trainer",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

function hostedOff() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...extra },
    body: JSON.stringify(body),
  });
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

beforeEach(() => {
  hostedOff();
  n = 0;
  row = {
    id: "u-mfa",
    email: "rep@example.test",
    firstName: "Ravi",
    lastName: "Shah",
    role: "owner",
    mfaEnabled: true,
    mfaSecret: SECRET,
    lastLoginAt: null,
    isPlatformAdmin: false,
    organization: { id: "org-1", name: "Harbor Point", code: "329927" },
  };
  mocks.prisma.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { id?: string } }) =>
    (where.id && where.id === row.id ? { ...row } : null));
  mocks.prisma.user.update.mockReset().mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    if (where.id !== row.id) throw new Error("Record to update not found.");
    Object.assign(row, data);
    return { ...row };
  });
  mocks.prisma.user.updateMany.mockReset();
  mocks.prisma.auditEvent.create.mockReset().mockResolvedValue({});
  vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({
    id: "cs_test_should_not_mint",
    url: "https://checkout.stripe.com/c/pay/cs_test_should_not_mint",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/mfa/challenge token kinds", () => {
  it("refuses a session JWT as the challenge, and sets no cookie", async () => {
    const session = signSessionToken({ id: row.id, email: row.email, role: "owner" });
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: session, code: totp() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Expired or invalid challenge. Sign in again." });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(row.lastLoginAt).toBeNull();
  });

  it("refuses an expired challenge token, and does not look the user up", async () => {
    const token = jwt.sign({ id: row.id, purpose: "mfa-challenge" }, KEY, { expiresIn: -10 });
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: token, code: totp() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Expired or invalid challenge. Sign in again." });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a challenge whose purpose claim is missing", async () => {
    const token = jwt.sign({ id: row.id, email: row.email }, KEY, { expiresIn: "5m" });
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: token, code: totp() }));
    expect(res.status).toBe(401);
    expect(setCookie(res)).not.toContain("authToken=");
  });

  it("does not mint a session when MFA has been turned off since the challenge was issued", async () => {
    row.mfaEnabled = false;
    row.mfaSecret = null;
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: signMfaChallengeToken(row.id), code: "123456" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "MFA is not enabled on this account." });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not mint a session for a challenge whose user row is gone", async () => {
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: signMfaChallengeToken("missing-user"), code: totp() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "MFA is not enabled on this account." });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("a wrong TOTP stays 401 with no cookie, and lastLoginAt is unchanged", async () => {
    const good = totp();
    const bad = good === "000000" ? "111111" : "000000";
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: signMfaChallengeToken(row.id), code: bad }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid code" });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(row.lastLoginAt).toBeNull();
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledWith({
      data: { userId: row.id, action: "user.mfa_challenge_failed", ip: expect.any(String) },
    });
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload without looking the user up", async () => {
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: signMfaChallengeToken(row.id), code: "12" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid challenge payload" });
    expect(setCookie(res)).not.toContain("authToken=");
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("a valid TOTP mints a session cookie, and that token is a session, not another challenge", async () => {
    const res = await challenge(post("/api/auth/mfa/challenge", { challengeToken: signMfaChallengeToken(row.id), code: totp() }));
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; user: { id: string } };
    expect(body.user.id).toBe(row.id);
    expect(setCookie(res)).toContain("authToken=");
    expect(setCookie(res).toLowerCase()).toContain("httponly");
    const session = verifySessionToken(body.token);
    expect(session).toMatchObject({ id: row.id, email: row.email, role: "owner" });
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});

describe("an MFA challenge cannot start billing", () => {
  it("POST /api/billing/checkout with the challenge token is 401 and does not call Stripe", async () => {
    const challengeToken = signMfaChallengeToken(row.id);
    const res = await checkout(post("/api/billing/checkout", { plan: "pro", interval: "month" }, {
      authorization: `Bearer ${challengeToken}`,
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("POST /api/billing/checkout with the challenge as a cookie is the same 401", async () => {
    const challengeToken = signMfaChallengeToken(row.id);
    const res = await checkout(post("/api/billing/checkout", { plan: "pro", interval: "month" }, {
      cookie: `authToken=${challengeToken}`,
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/mfa/challenge rate limit", () => {
  it("the eleventh attempt from one IP is 429 and does not mint a session", async () => {
    const from = "203.0.113.77";
    const body = { challengeToken: signMfaChallengeToken(row.id), code: totp() };
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await challenge(post("/api/auth/mfa/challenge", body, { "x-forwarded-for": from }));
    }
    expect(last!.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "Rate limit exceeded" });
    expect(setCookie(last!)).not.toContain("authToken=");
  });
});

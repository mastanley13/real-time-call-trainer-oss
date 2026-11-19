import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import jwt from "jsonwebtoken";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { POST as challengeRoute } from "@/app/api/auth/mfa/challenge/route";
import { GET as purge } from "@/app/api/cron/purge-expired/route";
import { signMfaChallengeToken, verifyMfaChallenge } from "@/lib/auth";
import { claimTotpStep, TOTP_PERIOD_SEC, verifyTotp } from "@/lib/mfa";

const JWT = "test-only-not-a-secret-0123456789abcdef";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");

function totpAt(atMs = Date.now()): string {
  return new OTPAuth.TOTP({
    issuer: "Real-Time Call Trainer",
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SEC,
    secret: OTPAuth.Secret.fromBase32(SECRET),
  }).generate({ timestamp: atMs });
}

let ipSeq = 0;
function post(token: string, code: string) {
  return challengeRoute(new NextRequest("http://localhost/api/auth/mfa/challenge", {
    method: "POST",
    body: JSON.stringify({ challengeToken: token, code }),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${(ipSeq++ % 200) + 1}`,
    },
  }));
}

function seedUser(extra: Record<string, unknown> = {}) {
  mocks.fake.seed("user", {
    id: "u-1",
    email: "rep@example.test",
    firstName: "Ravi",
    lastName: "Shah",
    role: "trainee",
    mfaEnabled: true,
    mfaSecret: SECRET,
    mfaLastTotpStep: null,
    isPlatformAdmin: false,
    organizationId: null,
    ...extra,
  });
}

describe("MFA challenge replay", () => {
  beforeEach(() => {
    mocks.fake = createFakePrisma();
    ipSeq = 0;
    vi.stubEnv("JWT_SECRET", JWT);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("the same challenge token plus the same code twice: first 200, then 401 with no cookie", async () => {
    seedUser();
    const token = signMfaChallengeToken("u-1");
    const code = totpAt();
    const first = await post(token, code);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("authToken=");
    const second = await post(token, code);
    expect(second.status).toBe(401);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(await second.json()).toEqual({ error: "Invalid code" });
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_failed")).toHaveLength(1);
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_success")).toHaveLength(1);
  });

  it("the same challenge token with a fresh valid code after a success: 401", async () => {
    seedUser();
    const token = signMfaChallengeToken("u-1");
    const firstCode = totpAt();
    expect((await post(token, firstCode)).status).toBe(200);
    vi.setSystemTime(NOW + TOTP_PERIOD_SEC * 1000);
    const fresh = totpAt();
    expect(fresh).not.toBe(firstCode);
    expect(verifyTotp(SECRET, fresh)).not.toBeNull();
    const res = await post(token, fresh);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "Invalid code" });
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_failed")).toHaveLength(1);
  });

  it("a new challenge token with the already-used TOTP step: 401", async () => {
    seedUser();
    const code = totpAt();
    expect((await post(signMfaChallengeToken("u-1"), code)).status).toBe(200);
    const res = await post(signMfaChallengeToken("u-1"), code);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "Invalid code" });
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_failed")).toHaveLength(1);
  });

  it("MFA turned off since issue", async () => {
    seedUser({ mfaEnabled: false, mfaSecret: SECRET });
    const res = await post(signMfaChallengeToken("u-1"), totpAt());
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "MFA is not enabled on this account." });
    expect(mocks.fake.rows("user")[0].mfaSecret).toBe(SECRET);
    expect(mocks.fake.rows("consumedMfaChallenge")).toHaveLength(0);
    expect(mocks.fake.rows("auditEvent")).toHaveLength(0);
  });

  it("a new challenge token with a later TOTP step still succeeds", async () => {
    seedUser();
    expect((await post(signMfaChallengeToken("u-1"), totpAt())).status).toBe(200);
    vi.setSystemTime(NOW + TOTP_PERIOD_SEC * 1000);
    const res = await post(signMfaChallengeToken("u-1"), totpAt());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("authToken=");
  });
});

describe("MFA challenge JWT and TOTP helpers", () => {
  beforeEach(() => {
    mocks.fake = createFakePrisma();
    vi.stubEnv("JWT_SECRET", JWT);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rejects a challenge JWT that has no jti", () => {
    const token = jwt.sign({ id: "u-1", purpose: "mfa-challenge" }, JWT, { expiresIn: "5m" });
    expect(verifyMfaChallenge(token)).toBeNull();
  });

  it("verifyTotp returns the matching time-step, including a one-step window", () => {
    const current = totpAt(NOW);
    expect(verifyTotp(SECRET, current, NOW)).toBe(Math.floor(NOW / 1000 / TOTP_PERIOD_SEC));
    const previous = totpAt(NOW - TOTP_PERIOD_SEC * 1000);
    expect(verifyTotp(SECRET, previous, NOW)).toBe(Math.floor(NOW / 1000 / TOTP_PERIOD_SEC) - 1);
    expect(verifyTotp(SECRET, "000000", NOW)).toBeNull();
  });

  it("claimTotpStep rejects a step less than or equal to the last accepted one", async () => {
    mocks.fake.seed("user", { id: "u-1", email: "rep@example.test", mfaLastTotpStep: null });
    expect(await claimTotpStep(mocks.fake.db, "u-1", 100)).toBe(true);
    expect(await claimTotpStep(mocks.fake.db, "u-1", 100)).toBe(false);
    expect(await claimTotpStep(mocks.fake.db, "u-1", 99)).toBe(false);
    expect(await claimTotpStep(mocks.fake.db, "u-1", 101)).toBe(true);
    expect(mocks.fake.rows("user")[0].mfaLastTotpStep).toBe(101);
  });
});

describe("purge of expired MFA challenge jtis", () => {
  beforeEach(() => {
    mocks.fake = createFakePrisma();
    vi.stubEnv("CRON_SECRET", "cron-test-secret-not-real");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("deletes consumed jtis that have expired and keeps live ones", async () => {
    mocks.fake.seed("consumedMfaChallenge", { id: "old-jti-0000000000000000000000000000", expiresAt: new Date(NOW - 1000) });
    mocks.fake.seed("consumedMfaChallenge", { id: "live-jti-000000000000000000000000000", expiresAt: new Date(NOW + 60_000) });
    const res = await purge(new NextRequest("https://trainer.example/api/cron/purge-expired", {
      headers: { authorization: "Bearer cron-test-secret-not-real" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { consumedChallengesDeleted: number };
    expect(body.consumedChallengesDeleted).toBe(1);
    expect(mocks.fake.rows("consumedMfaChallenge").map((r) => r.id)).toEqual(["live-jti-000000000000000000000000000"]);
  });
});

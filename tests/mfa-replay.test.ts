import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import jwt from "jsonwebtoken";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { POST as challengeRoute } from "@/app/api/auth/mfa/challenge/route";
import { POST as activateRoute } from "@/app/api/auth/mfa/activate/route";
import { POST as disableRoute } from "@/app/api/auth/mfa/disable/route";
import { GET as purge } from "@/app/api/cron/purge-expired/route";
import { CHALLENGE_EXPIRED, CODE_USED_ERROR, CODE_USED_MESSAGE } from "@/lib/authCopy";
import { signMfaChallengeToken, signSessionToken, verifyMfaChallenge } from "@/lib/auth";
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

  it("the same challenge token plus the same code twice: first 200, then expired-challenge copy", async () => {
    seedUser();
    const token = signMfaChallengeToken("u-1");
    const code = totpAt();
    const first = await post(token, code);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("authToken=");
    const second = await post(token, code);
    expect(second.status).toBe(401);
    expect(second.headers.get("set-cookie")).toBeNull();
    const body = await second.json();
    expect(body).toEqual({ error: CHALLENGE_EXPIRED });
    expect(JSON.stringify(body)).not.toContain("Invalid code");
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_success")).toHaveLength(1);
  });

  it("the same challenge token with a fresh valid code after a success: expired-challenge copy", async () => {
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
    const body = await res.json();
    expect(body).toEqual({ error: CHALLENGE_EXPIRED });
    expect(JSON.stringify(body)).not.toContain("Invalid code");
  });

  it("a new challenge token with the already-used TOTP step: code_used", async () => {
    seedUser();
    const code = totpAt();
    expect((await post(signMfaChallengeToken("u-1"), code)).status).toBe(200);
    const res = await post(signMfaChallengeToken("u-1"), code);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: CODE_USED_ERROR, message: CODE_USED_MESSAGE });
    expect(mocks.fake.rows("auditEvent").filter((e) => e.action === "user.mfa_challenge_failed")).toHaveLength(1);
  });

  it("a challenge JWT with no jti gets the expired-challenge copy, never Invalid code", async () => {
    seedUser();
    const token = jwt.sign({ id: "u-1", purpose: "mfa-challenge" }, JWT, { expiresIn: "5m" });
    const res = await post(token, totpAt());
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ error: CHALLENGE_EXPIRED });
    expect(JSON.stringify(body)).not.toContain("Invalid code");
  });

  it("a wrong code on a fresh challenge is still Invalid code", async () => {
    seedUser();
    const res = await post(signMfaChallengeToken("u-1"), "000000");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid code" });
    expect(mocks.fake.rows("auditEvent").some((e) => e.action === "user.mfa_challenge_failed")).toBe(true);
  });

  it("a consumed jti with a wrong code still gets the expired-challenge copy", async () => {
    seedUser();
    const token = signMfaChallengeToken("u-1");
    expect((await post(token, totpAt())).status).toBe(200);
    const res = await post(token, "000000");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: CHALLENGE_EXPIRED });
    expect(JSON.stringify(body)).not.toContain("Invalid code");
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

function sessionReq(path: string, code: string) {
  const token = signSessionToken({ id: "u-1", email: "rep@example.test" });
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify({ code }),
    headers: { "content-type": "application/json", cookie: `authToken=${token}` },
  });
}

describe("MFA activate and disable TOTP reuse", () => {
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

  it("activate returns code_used when the TOTP step was already accepted", async () => {
    seedUser({ mfaEnabled: false, mfaLastTotpStep: Math.floor(NOW / 1000 / TOTP_PERIOD_SEC) });
    const res = await activateRoute(sessionReq("/api/auth/mfa/activate", totpAt()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: CODE_USED_ERROR, message: CODE_USED_MESSAGE });
    expect(mocks.fake.rows("user")[0].mfaEnabled).toBe(false);
    expect(mocks.fake.rows("auditEvent").some((e) => e.action === "user.mfa_activation_failed")).toBe(true);
  });

  it("disable returns code_used when the TOTP step was already accepted", async () => {
    seedUser({ mfaEnabled: true, mfaLastTotpStep: Math.floor(NOW / 1000 / TOTP_PERIOD_SEC) });
    const res = await disableRoute(sessionReq("/api/auth/mfa/disable", totpAt()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: CODE_USED_ERROR, message: CODE_USED_MESSAGE });
    expect(mocks.fake.rows("user")[0].mfaEnabled).toBe(true);
    expect(mocks.fake.rows("auditEvent").some((e) => e.action === "user.mfa_disable_failed")).toBe(true);
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

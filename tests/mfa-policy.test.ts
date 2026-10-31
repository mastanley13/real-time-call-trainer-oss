import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { canEnforceMfa, graceEndFor, isEnrollmentPath, mfaStateFor } from "@/lib/mfaPolicy";
import { signSessionToken, verifySessionToken } from "@/lib/auth";

const NOW = new Date("2026-10-31T12:00:00Z");
const DAY = 86_400_000;

describe("mfaStateFor", () => {
  it("does nothing when the org does not require MFA", () => {
    expect(mfaStateFor({ requireMfa: false, mfaGraceEndsAt: null, mfaEnabled: false }, NOW)).toBe("not_required");
  });
  it("marks enrolled members compliant", () => {
    expect(mfaStateFor({ requireMfa: true, mfaGraceEndsAt: null, mfaEnabled: true }, NOW)).toBe("compliant");
  });
  it("forces enrollment at once with no grace period", () => {
    expect(mfaStateFor({ requireMfa: true, mfaGraceEndsAt: null, mfaEnabled: false }, NOW)).toBe("enroll_required");
  });
  it("only warns while the grace period runs, then forces enrollment", () => {
    const ends = new Date(NOW.getTime() + DAY);
    expect(mfaStateFor({ requireMfa: true, mfaGraceEndsAt: ends, mfaEnabled: false }, NOW)).toBe("grace");
    expect(mfaStateFor({ requireMfa: true, mfaGraceEndsAt: ends, mfaEnabled: false }, new Date(ends.getTime() + 1))).toBe("enroll_required");
  });
  it("puts a reset member back into forced enrollment", () => {
    const expired = new Date(NOW.getTime() - DAY);
    expect(mfaStateFor({ requireMfa: true, mfaGraceEndsAt: expired, mfaEnabled: false }, NOW)).toBe("enroll_required");
  });
});

describe("plan and grace helpers", () => {
  it("allows enforcement on the team plan only", () => {
    expect(canEnforceMfa("team")).toBe(true);
    expect(canEnforceMfa("free")).toBe(false);
    expect(canEnforceMfa(null)).toBe(false);
  });
  it("has no grace period unless days are given, and caps it", () => {
    expect(graceEndFor(undefined, NOW)).toBeNull();
    expect(graceEndFor(0, NOW)).toBeNull();
    expect(graceEndFor(7, NOW)?.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(graceEndFor(500, NOW)?.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });
  it("lets a forced member reach only enrollment and sign-in pages", () => {
    expect(isEnrollmentPath("/settings/security")).toBe(true);
    expect(isEnrollmentPath("/login")).toBe(true);
    expect(isEnrollmentPath("/trainer")).toBe(false);
    expect(isEnrollmentPath("/settings/models")).toBe(false);
    expect(isEnrollmentPath("/settings/securityx")).toBe(false);
  });
});

describe("limited enrollment session", () => {
  const saved = { JWT_SECRET: process.env.JWT_SECRET, DEMO_MODE: process.env.DEMO_MODE };
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-0123456789abcdef0123456789";
    delete process.env.DEMO_MODE;
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  const req = (token: string) => new NextRequest("http://localhost/api/x", { headers: { authorization: `Bearer ${token}` } });
  const limited = () => signSessionToken({ id: "u1", email: "u1@example.test", role: "trainee", mfaEnrollment: true });
  const full = () => signSessionToken({ id: "u1", email: "u1@example.test", role: "trainee" });

  it("round-trips the flag and omits it on full sessions", () => {
    expect(verifySessionToken(limited())?.mfaEnrollment).toBe(true);
    expect(verifySessionToken(full())?.mfaEnrollment).toBeUndefined();
  });

  it("is refused by ordinary routes with 403 and accepted by enrollment routes", async () => {
    const { requireAuth } = await import("@/lib/apiAuth");
    const blocked = requireAuth(req(limited()));
    expect(blocked).toBeInstanceOf(Response);
    expect((blocked as Response).status).toBe(403);
    expect(await (blocked as Response).json()).toMatchObject({ error: "mfa_enrollment_required" });

    const allowed = requireAuth(req(limited()), { allowMfaEnrollment: true });
    expect(allowed).toMatchObject({ id: "u1", mfaEnrollment: true });
    expect(requireAuth(req(full()))).toMatchObject({ id: "u1" });
  });
});

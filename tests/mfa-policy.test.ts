import { describe, expect, it } from "vitest";
import { canEnforceMfa, canRequireMfa, graceEndFor, isEnrollmentPath, mfaStateFor } from "@/lib/mfaPolicy";

const NOW = new Date("2026-10-31T12:00:00Z");
const DAY = 86_400_000;

describe("canRequireMfa", () => {
  it("needs the acting user to be enrolled", () => {
    expect(canRequireMfa({ mfaEnabled: true })).toBe(true);
    expect(canRequireMfa({ mfaEnabled: false })).toBe(false);
  });
});

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

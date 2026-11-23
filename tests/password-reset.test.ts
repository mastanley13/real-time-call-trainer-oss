import { describe, expect, it } from "vitest";
import {
  fingerprintMatches,
  passwordFingerprint,
  RESET_TOKEN_TTL_MS,
  resetLink,
  resetLinkOrigin,
  signResetToken,
  verifyResetToken,
} from "@/lib/passwordReset";
import { RESET_REQUEST_MESSAGE, RESET_TTL_MINUTES } from "@/lib/passwordReset-types";
import { passwordSchema, PASSWORD_MIN_LENGTH } from "@/lib/passwordRules";

const SECRET = "test-only-secret-0123456789abcdef";
const OTHER_SECRET = "another-test-secret-0123456789abcd";
const NOW = 1_800_000_000_000;
const HASH = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234";

const sign = (over: Partial<Parameters<typeof signResetToken>[0]> = {}) =>
  signResetToken({ userId: "user-1", passwordHash: HASH, secret: SECRET, now: NOW, ...over });

describe("reset token sign and verify", () => {
  it("accepts a fresh token and returns its claims", () => {
    const claims = verifyResetToken(sign(), { secret: SECRET, now: NOW + 1000 });
    expect(claims).not.toBeNull();
    expect(claims!.userId).toBe("user-1");
    expect(claims!.expiresAt).toBe(NOW + RESET_TOKEN_TTL_MS);
    expect(fingerprintMatches(claims!.fingerprint, HASH, SECRET)).toBe(true);
  });

  it("lasts 15 minutes, derived from RESET_TTL_MINUTES", () => {
    expect(RESET_TTL_MINUTES).toBe(15);
    expect(RESET_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(RESET_TOKEN_TTL_MS).toBe(RESET_TTL_MINUTES * 60 * 1000);
    expect(verifyResetToken(sign(), { secret: SECRET, now: NOW + RESET_TOKEN_TTL_MS - 1 })).not.toBeNull();
    // A link 16 minutes old is dead.
    expect(verifyResetToken(sign(), { secret: SECRET, now: NOW + 16 * 60 * 1000 })).toBeNull();
  });

  it("says the same number of minutes in the request message", () => {
    expect(RESET_REQUEST_MESSAGE).toContain(`expires in ${RESET_TTL_MINUTES} minutes`);
    expect(RESET_REQUEST_MESSAGE).toContain("15 minutes");
  });

  it("rejects an expired token", () => {
    expect(verifyResetToken(sign(), { secret: SECRET, now: NOW + RESET_TOKEN_TTL_MS })).toBeNull();
    expect(verifyResetToken(sign(), { secret: SECRET, now: NOW + RESET_TOKEN_TTL_MS + 60_000 })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyResetToken(sign({ secret: OTHER_SECRET }), { secret: SECRET, now: NOW })).toBeNull();
  });

  it("rejects a tampered user id, expiry, fingerprint or signature", () => {
    const parts = sign().split(".");
    const swap = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join(".");
    expect(verifyResetToken(swap(1, Buffer.from("user-2").toString("base64url")), { secret: SECRET, now: NOW })).toBeNull();
    expect(verifyResetToken(swap(2, String(NOW + 10 * RESET_TOKEN_TTL_MS)), { secret: SECRET, now: NOW })).toBeNull();
    expect(verifyResetToken(swap(3, passwordFingerprint("other", SECRET)), { secret: SECRET, now: NOW })).toBeNull();
    const sig = parts[4];
    expect(verifyResetToken(swap(4, (sig[0] === "A" ? "B" : "A") + sig.slice(1)), { secret: SECRET, now: NOW })).toBeNull();
    expect(verifyResetToken(swap(4, sig.slice(0, -2)), { secret: SECRET, now: NOW })).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const t of ["", "abc", "v1.a.b.c", "v2" + sign().slice(2), sign() + ".x", "x".repeat(600)]) {
      expect(verifyResetToken(t, { secret: SECRET, now: NOW })).toBeNull();
    }
  });

  it("stops matching once the password changes", () => {
    const claims = verifyResetToken(sign(), { secret: SECRET, now: NOW })!;
    expect(fingerprintMatches(claims.fingerprint, HASH, SECRET)).toBe(true);
    expect(fingerprintMatches(claims.fingerprint, "$2b$12$newhashnewhashnewhashnewhashnewhashnewhashnewhash12", SECRET)).toBe(false);
    expect(fingerprintMatches(claims.fingerprint, null, SECRET)).toBe(false);
  });

  it("works for an account with no password, until one is set", () => {
    const claims = verifyResetToken(sign({ passwordHash: null }), { secret: SECRET, now: NOW })!;
    expect(fingerprintMatches(claims.fingerprint, null, SECRET)).toBe(true);
    expect(fingerprintMatches(claims.fingerprint, undefined, SECRET)).toBe(true);
    expect(fingerprintMatches(claims.fingerprint, HASH, SECRET)).toBe(false);
  });

  it("never puts the password hash in the token", () => {
    const token = sign();
    expect(token).not.toContain(HASH);
    expect(token).not.toContain(Buffer.from(HASH).toString("base64url"));
  });
});

describe("resetLinkOrigin", () => {
  it("uses the APP_URL origin", () => {
    expect(resetLinkOrigin({ APP_URL: "https://calltrainer.example/some/path", NODE_ENV: "production" })).toBe("https://calltrainer.example");
  });

  it("returns null in production without a usable APP_URL", () => {
    expect(resetLinkOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(resetLinkOrigin({ NODE_ENV: "production", APP_URL: "javascript:alert(1)" })).toBeNull();
    expect(resetLinkOrigin({ NODE_ENV: "production", APP_URL: "calltrainer.example" })).toBeNull();
  });

  it("falls back to localhost outside production", () => {
    expect(resetLinkOrigin({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(resetLinkOrigin({ NODE_ENV: "test", PORT: "4000" })).toBe("http://localhost:4000");
  });

  it("builds the reset link with an encoded token", () => {
    expect(resetLink("https://calltrainer.example", "v1.a.b")).toBe("https://calltrainer.example/reset-password?token=v1.a.b");
  });
});

describe("passwordSchema", () => {
  it("matches the sign-up rule of 10 to 200 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(passwordSchema.safeParse("x".repeat(9)).success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(10)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(200)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(201)).success).toBe(false);
  });
});

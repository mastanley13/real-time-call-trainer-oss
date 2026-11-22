import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fingerprintMatches,
  passwordFingerprint,
  RESET_TOKEN_TTL_MS,
  resetLink,
  resetLinkOrigin,
  signResetToken,
  verifyResetToken,
} from "@/lib/passwordReset";
import { mailConfigured, RESEND_ENDPOINT, sendMail } from "@/lib/mailer";
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

  it("lasts 30 minutes", () => {
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect(verifyResetToken(sign(), { secret: SECRET, now: NOW + RESET_TOKEN_TTL_MS - 1 })).not.toBeNull();
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

describe("sendMail", () => {
  const msg = { to: "mia@example.test", subject: "Reset", text: "Link: http://localhost/reset-password?token=SECRET-TOKEN", html: "<p>x</p>" };

  afterEach(() => vi.restoreAllMocks());

  it("is configured only with both RESEND_API_KEY and MAIL_FROM", () => {
    expect(mailConfigured({ RESEND_API_KEY: "re_test" })).toBe(false);
    expect(mailConfigured({ MAIL_FROM: "a@example.test" })).toBe(false);
    expect(mailConfigured({ RESEND_API_KEY: "re_test", MAIL_FROM: "a@example.test" })).toBe(true);
  });

  it("logs the message outside production when not configured", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await sendMail(msg, { NODE_ENV: "development" })).toEqual({ ok: false, reason: "not_configured" });
    expect(info.mock.calls[0][0]).toContain("SECRET-TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs the message in demo mode outside production", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await sendMail(msg, { NODE_ENV: "development", DEMO_MODE: "true" });
    expect(info.mock.calls[0][0]).toContain("SECRET-TOKEN");
  });

  it("never logs the link, token or recipient in production, even with DEMO_MODE=true", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await sendMail(msg, { NODE_ENV: "production", DEMO_MODE: "true" })).toEqual({ ok: false, reason: "not_configured" });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(logged).not.toContain("SECRET-TOKEN");
    expect(logged).not.toContain("reset-password");
    expect(logged).not.toContain("mia@example.test");
    expect(logged).toContain("not configured");
    expect(vi.mocked(console.warn)).toHaveBeenCalledOnce();
    expect(vi.mocked(console.info)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns once in production with no token or address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await sendMail(msg, { NODE_ENV: "production" })).toEqual({ ok: false, reason: "not_configured" });
    expect(warn).toHaveBeenCalledOnce();
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("SECRET-TOKEN");
    expect(line).not.toContain("mia@example.test");
    expect(info).not.toHaveBeenCalled();
  });

  it("posts to Resend when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const env = { NODE_ENV: "production", RESEND_API_KEY: "re_test", MAIL_FROM: "Trainer <no-reply@example.test>" };
    expect(await sendMail(msg, env)).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(RESEND_ENDPOINT);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(init!.body))).toEqual({ from: env.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html });
  });

  it("never throws and logs only the status on a provider error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("echo mia@example.test", { status: 422 }));
    const env = { RESEND_API_KEY: "re_test", MAIL_FROM: "no-reply@example.test" };
    expect(await sendMail(msg, env)).toEqual({ ok: false, reason: "failed" });
    expect(String(error.mock.calls[0][0])).toContain("422");
    expect(String(error.mock.calls[0][0])).not.toContain("mia@example.test");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await sendMail(msg, env)).toEqual({ ok: false, reason: "failed" });
  });
});

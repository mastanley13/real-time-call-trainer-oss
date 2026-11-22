import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database, the rate limiter, the mailer and after() are the fakes; the routes and the token code run for real.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
  rateLimit: vi.fn(),
  sendMail: vi.fn(),
  after: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), rateLimit: mocks.rateLimit }));
vi.mock("@/lib/mailer", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/mailer")>()), sendMail: mocks.sendMail }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: mocks.after }));

import { POST as requestReset } from "@/app/api/auth/password-reset/request/route";
import { POST as confirmReset } from "@/app/api/auth/password-reset/confirm/route";
import { POST as register } from "@/app/api/auth/register/route";
import { signResetToken } from "@/lib/passwordReset";
import { RESET_INVALID_MESSAGE, RESET_REQUEST_MESSAGE } from "@/lib/passwordReset-types";
import { PASSWORD_MIN_MESSAGE } from "@/lib/passwordRules";

const SECRET = "test-only-secret-0123456789abcdef";
const HASH = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
const USER = { id: "user-1", email: "mia@example.test", passwordHash: HASH };

const json = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** Runs every after() callback the route scheduled. */
async function flushAfter() {
  for (const [cb] of mocks.after.mock.calls) await (cb as () => Promise<void>)();
}

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://x:x@localhost:5432/x");
  vi.stubEnv("APP_URL", "https://calltrainer.example");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("TRAINER_ACCESS_CODE", "");
  mocks.rateLimit.mockReset().mockReturnValue({ allowed: true, remaining: 1, retryAfterMs: 0 });
  mocks.prisma.user.findUnique.mockReset().mockResolvedValue(null);
  mocks.prisma.user.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.prisma.auditEvent.create.mockReset().mockResolvedValue({});
  mocks.sendMail.mockReset().mockResolvedValue({ ok: true });
  mocks.after.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/password-reset/request", () => {
  it("answers an unknown email and a known email with the same status and body", async () => {
    const missing = await requestReset(json("/api/auth/password-reset/request", { email: "nobody@example.test" }));
    mocks.prisma.user.findUnique.mockResolvedValue(USER);
    const known = await requestReset(json("/api/auth/password-reset/request", { email: "Mia@Example.test" }));

    expect(missing.status).toBe(200);
    expect(known.status).toBe(200);
    const a = await missing.json();
    const b = await known.json();
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });
  });

  it("does the token, email and audit work only after the response, and only for a real account", async () => {
    await requestReset(json("/api/auth/password-reset/request", { email: "nobody@example.test" }));
    expect(mocks.after).not.toHaveBeenCalled();

    mocks.prisma.user.findUnique.mockResolvedValue(USER);
    await requestReset(json("/api/auth/password-reset/request", { email: "MIA@example.test" }));
    expect(mocks.prisma.user.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { email: "mia@example.test" } }));
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.sendMail).not.toHaveBeenCalled();

    await flushAfter();
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    const mail = mocks.sendMail.mock.calls[0][0];
    expect(mail.to).toBe(USER.email);
    expect(mail.text).toMatch(/https:\/\/calltrainer\.example\/reset-password\?token=v1\./);
    expect(mail.text).toContain("30 minutes");
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: USER.id, action: "user.password_reset_requested" }) }),
    );
  });

  it("builds the link from APP_URL, never the Host header", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(USER);
    const req = new NextRequest("http://evil.example/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: USER.email }),
      headers: { "content-type": "application/json", host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    await requestReset(req);
    await flushAfter();
    expect(mocks.sendMail.mock.calls[0][0].text).not.toContain("evil.example");
  });

  it("sends nothing in production when APP_URL is unset, and logs no address", async () => {
    vi.stubEnv("APP_URL", "");
    mocks.prisma.user.findUnique.mockResolvedValue(USER);
    const res = await requestReset(json("/api/auth/password-reset/request", { email: USER.email }));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toContain(USER.email);
  });

  it("still answers 200 with the same body when the per-email limit is hit, without a lookup", async () => {
    mocks.rateLimit.mockImplementation(({ key }: { key: string }) =>
      key.startsWith("pwreset-email:") ? { allowed: false, remaining: 0, retryAfterMs: 1000 } : { allowed: true, remaining: 1, retryAfterMs: 0 },
    );
    mocks.prisma.user.findUnique.mockResolvedValue(USER);
    const res = await requestReset(json("/api/auth/password-reset/request", { email: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the IP is over its limit", async () => {
    mocks.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 30_000 });
    const res = await requestReset(json("/api/auth/password-reset/request", { email: USER.email }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("still answers 200 when the lookup throws", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    const res = await requestReset(json("/api/auth/password-reset/request", { email: USER.email }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: RESET_REQUEST_MESSAGE });
  });

  it("rejects a bad email with 400", async () => {
    const res = await requestReset(json("/api/auth/password-reset/request", { email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 503 without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await requestReset(json("/api/auth/password-reset/request", { email: USER.email }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("database_not_configured");
  });
});

describe("POST /api/auth/password-reset/confirm", () => {
  const token = (over: Partial<Parameters<typeof signResetToken>[0]> = {}) =>
    signResetToken({ userId: USER.id, passwordHash: HASH, secret: SECRET, now: Date.now(), ...over });
  const confirm = (body: unknown) => confirmReset(json("/api/auth/password-reset/confirm", body));

  it("sets the new password, clears the lockout and does not sign in", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: HASH });
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toBeNull();

    const args = mocks.prisma.user.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: USER.id, passwordHash: HASH });
    expect(args.data.failedLoginCount).toBe(0);
    expect(args.data.lockedUntil).toBeNull();
    expect(args.data.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(args.data.passwordHash).not.toBe(HASH);
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "user.password_reset_completed" }) }),
    );
  }, 20_000);

  it("rejects a link after the password has changed", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: "$2b$12$changedchangedchangedchangedchangedchangedchanged12" });
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token", message: RESET_INVALID_MESSAGE });
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("gives the same generic error for expired, forged and unknown-user tokens", async () => {
    const expired = await confirm({ token: token({ now: Date.now() - 31 * 60_000 }), password: "a-brand-new-password" });
    const forged = await confirm({ token: token({ secret: "another-test-secret-0123456789abcd" }), password: "a-brand-new-password" });
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    const unknown = await confirm({ token: token(), password: "a-brand-new-password" });
    for (const res of [expired, forged, unknown]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_token", message: RESET_INVALID_MESSAGE });
    }
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("still returns success when the audit insert fails after the password changed", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: HASH });
    mocks.prisma.auditEvent.create.mockRejectedValue(new Error("audit table down"));
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.prisma.user.updateMany).toHaveBeenCalledOnce();
    const error = vi.mocked(console.error);
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0][0]);
    expect(line).not.toContain(USER.id);
    expect(line).not.toContain(USER.email);
    expect(line).not.toContain("audit table down");
  }, 20_000);

  it("rejects the loser of a race on the same link", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: HASH });
    mocks.prisma.user.updateMany.mockResolvedValue({ count: 0 });
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(400);
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  }, 20_000);

  it("enforces the sign-up password rule", async () => {
    const res = await confirm({ token: token(), password: "short" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_password", message: PASSWORD_MIN_MESSAGE });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 503 without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("database_not_configured");
  });
});

describe("password rule parity with sign-up", () => {
  const signup = (password: string) =>
    register(json("/api/auth/register", { firstName: "Mia", lastName: "Chen", email: USER.email, password, newOrgName: "Example Team" }));

  it("rejects the same too-short password with the same message", async () => {
    const res = await signup("x".repeat(9));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(PASSWORD_MIN_MESSAGE);
  });

  it("accepts a 10 character password past validation", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "u-existing" });
    const res = await signup("x".repeat(10));
    expect(res.status).toBe(409);
  });
});

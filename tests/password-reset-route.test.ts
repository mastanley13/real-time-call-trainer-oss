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
import { POST as checkReset } from "@/app/api/auth/password-reset/check/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST as register } from "@/app/api/auth/register/route";
import { signResetToken } from "@/lib/passwordReset";
import { RESET_INVALID_MESSAGE, RESET_REQUEST_MESSAGE } from "@/lib/passwordReset-types";
import { PASSWORD_MIN_MESSAGE } from "@/lib/passwordRules";

const SECRET = "test-only-secret-0123456789abcdef";
const HASH = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
const USER = { id: "user-1", email: "mia@example.test", passwordHash: HASH };

const json = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** updateMany calls that wrote a password (as opposed to the lock-aware counter clear that follows a reset). */
const passwordWrites = () =>
  mocks.prisma.user.updateMany.mock.calls.filter(([args]) => "passwordHash" in (args as { data: object }).data);

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

  it("sets the new password, then clears the lockout only through the lock-aware, MFA-off condition, and does not sign in", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: HASH });
    const res = await confirm({ token: token(), password: "a-brand-new-password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toBeNull();

    // First write: the password alone, conditional on the hash the token was issued for.
    const args = mocks.prisma.user.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: USER.id, passwordHash: HASH });
    expect(Object.keys(args.data)).toEqual(["passwordHash"]);
    expect(args.data.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(args.data.passwordHash).not.toBe(HASH);
    // Second write: the counters, only while MFA is off and no lock is active.
    const clear = mocks.prisma.user.updateMany.mock.calls[1][0];
    expect(clear.where).toMatchObject({ id: USER.id, mfaEnabled: false, OR: [{ lockedUntil: null }, { lockedUntil: { lte: expect.any(Date) } }] });
    expect(clear.data).toEqual({ failedLoginCount: 0, lockedUntil: null });
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
    expect(passwordWrites()).toHaveLength(1);
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

describe("password reset and the shared lockout counters", () => {
  type Row = { id: string; passwordHash: string; mfaEnabled: boolean; failedLoginCount: number; lockedUntil: Date | null };
  type Where = Record<string, unknown>;
  const confirm = () =>
    confirmReset(json("/api/auth/password-reset/confirm", {
      token: signResetToken({ userId: USER.id, passwordHash: HASH, secret: SECRET, now: Date.now() }),
      password: "a-brand-new-password",
    }));
  const inFifteen = () => new Date(Date.now() + 15 * 60_000);

  /**
   * One stored user whose updateMany honors its where clause (id, passwordHash, mfaEnabled and the not-locked OR),
   * so a conditional write that no longer matches really returns count 0. `afterPasswordWrite` runs right after the
   * password write commits, as another request would between the route's two statements.
   */
  function storedUser(init: Partial<Row>, afterPasswordWrite?: (row: Row) => void): Row {
    const row: Row = { id: USER.id, passwordHash: HASH, mfaEnabled: false, failedLoginCount: 0, lockedUntil: null, ...init };
    const holds = (where: Where): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (k === "OR") return (v as Where[]).some(holds);
        if (k === "lockedUntil" && v && typeof v === "object") return row.lockedUntil !== null && row.lockedUntil <= (v as { lte: Date }).lte;
        return (row as Record<string, unknown>)[k] === v;
      });
    mocks.prisma.user.findUnique.mockImplementation(async () => ({ id: row.id, passwordHash: row.passwordHash }));
    mocks.prisma.user.updateMany.mockImplementation(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      if (!holds(where)) return { count: 0 };
      Object.assign(row, data);
      if ("passwordHash" in data) afterPasswordWrite?.(row);
      return { count: 1 };
    });
    return row;
  }
  const auditMeta = () => mocks.prisma.auditEvent.create.mock.calls.at(-1)?.[0].data.metadata;

  it("MFA on: a reset changes the password but does not lift a lock built up by wrong MFA codes", async () => {
    const until = inFifteen();
    const row = storedUser({ mfaEnabled: true, lockedUntil: until });
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(row.passwordHash).not.toBe(HASH);
    expect(row.lockedUntil).toEqual(until);
    expect(auditMeta()).toEqual({ countersCleared: false });
  }, 20_000);

  it("MFA on: a reset does not reset the failure count, so MFA guessing cannot go on", async () => {
    const row = storedUser({ mfaEnabled: true, failedLoginCount: 6 });
    expect((await confirm()).status).toBe(200);
    expect(row).toMatchObject({ failedLoginCount: 6, lockedUntil: null });
  }, 20_000);

  it("MFA off: a reset clears the count and an expired lock", async () => {
    const row = storedUser({ failedLoginCount: 5, lockedUntil: new Date(Date.now() - 1000) });
    expect((await confirm()).status).toBe(200);
    expect(row).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    expect(row.passwordHash).not.toBe(HASH);
    expect(auditMeta()).toEqual({ countersCleared: true });
  }, 20_000);

  it("MFA off, lock active at reset time: the password still changes, the lock is kept", async () => {
    const until = inFifteen();
    const row = storedUser({ lockedUntil: until });
    expect((await confirm()).status).toBe(200);
    expect(row.passwordHash).not.toBe(HASH);
    expect(row.lockedUntil).toEqual(until);
    expect(auditMeta()).toEqual({ countersCleared: false });
  }, 20_000);

  it("MFA off, lock armed by concurrent failures between the password write and the clear: the lock is kept", async () => {
    const until = inFifteen();
    const row = storedUser({ failedLoginCount: 7 }, (r) => Object.assign(r, { failedLoginCount: 0, lockedUntil: until }));
    expect((await confirm()).status).toBe(200);
    expect(row.passwordHash).not.toBe(HASH);
    expect(row.lockedUntil).toEqual(until);
  }, 20_000);

  it("MFA turned on between the token check and the clear: the counters are left alone", async () => {
    const row = storedUser({ failedLoginCount: 4 }, (r) => { r.mfaEnabled = true; });
    expect((await confirm()).status).toBe(200);
    expect(row.failedLoginCount).toBe(4);
  }, 20_000);

  it("if the counter write fails, the password change still stands and the log line leaks nothing", async () => {
    const row = storedUser({ failedLoginCount: 3 });
    const base = mocks.prisma.user.updateMany.getMockImplementation()!;
    mocks.prisma.user.updateMany.mockImplementation(async (args: { where: Where; data: Partial<Row> }) => {
      if (!("passwordHash" in args.data)) throw new Error("connection reset with secret detail");
      return base(args);
    });
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(row.passwordHash).not.toBe(HASH);
    expect(row.failedLoginCount).toBe(3);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    for (const leak of [USER.id, USER.email, "secret detail"]) expect(line).not.toContain(leak);
  }, 20_000);
});

describe("dead links: check and confirm agree", () => {
  const CHANGED = "$2b$12$changedchangedchangedchangedchangedchangedchanged12";
  const fresh = (over: Partial<Parameters<typeof signResetToken>[0]> = {}) =>
    signResetToken({ userId: USER.id, passwordHash: HASH, secret: SECRET, now: Date.now(), ...over });
  const check = (body: unknown) => checkReset(json("/api/auth/password-reset/check", body));
  const confirm = (token: string) => confirmReset(json("/api/auth/password-reset/confirm", { token, password: "a-brand-new-password" }));

  /** Each case: the token and the stored user the lookup returns. */
  const deadCases: Array<[string, () => string, unknown]> = [
    ["garbage", () => "not-a-token", { id: USER.id, passwordHash: HASH }],
    ["bad signature", () => fresh({ secret: "another-test-secret-0123456789abcd" }), { id: USER.id, passwordHash: HASH }],
    ["expired", () => fresh({ now: Date.now() - 31 * 60_000 }), { id: USER.id, passwordHash: HASH }],
    ["unknown user", () => fresh(), null],
    ["used (password since changed)", () => fresh(), { id: USER.id, passwordHash: CHANGED }],
    ["over-length", () => `${fresh()}${"x".repeat(600)}`, { id: USER.id, passwordHash: HASH }],
  ];

  it.each(deadCases)("check answers %s with the same body, no info and no writes", async (_name, tok, stored) => {
    mocks.prisma.user.findUnique.mockResolvedValue(stored);
    const res = await check({ token: tok() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ valid: false });
    for (const leak of [USER.id, USER.email, "expire", "reason"]) expect(text).not.toContain(leak);
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it.each(deadCases)("confirm rejects %s", async (_name, tok, stored) => {
    mocks.prisma.user.findUnique.mockResolvedValue(stored);
    const res = await confirm(tok());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token", message: RESET_INVALID_MESSAGE });
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("check answers a malformed body the same way", async () => {
    for (const body of [{}, { token: 42 }, { token: "" }]) {
      const res = await check(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ valid: false });
    }
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("check answers a fresh link with valid, and writes nothing", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: USER.id, passwordHash: HASH });
    const res = await check({ token: fresh() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ valid: true });
    expect(text).not.toContain(USER.id);
    expect(text).not.toContain(USER.email);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: USER.id }, select: { id: true, passwordHash: true } });
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("a link is valid, confirms once, then check and confirm both reject it", async () => {
    const stored = { id: USER.id, passwordHash: HASH };
    mocks.prisma.user.findUnique.mockImplementation(async () => ({ ...stored }));
    mocks.prisma.user.updateMany.mockImplementation(async ({ data }: { data: { passwordHash?: string } }) => {
      if (data.passwordHash) stored.passwordHash = data.passwordHash;
      return { count: 1 };
    });
    const tok = fresh();
    expect(await (await check({ token: tok })).json()).toEqual({ valid: true });
    expect((await confirm(tok)).status).toBe(200);
    expect(await (await check({ token: tok })).json()).toEqual({ valid: false });
    expect((await confirm(tok)).status).toBe(400);
    expect(passwordWrites()).toHaveLength(1);
  }, 20_000);

  it("check uses its own per-IP bucket and returns 429 with Retry-After", async () => {
    mocks.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 30_000 });
    const res = await check({ token: fresh() });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rateLimit.mock.calls[0][0].key).toMatch(/^pwreset-check:/);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("check returns 503 without a database, like confirm", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await check({ token: fresh() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(await (await confirm(fresh())).json());
  });

  it("check returns 500 with no details when the lookup throws", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down at 10.0.0.5"));
    const res = await check({ token: fresh() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("db down");
    expect(JSON.parse(text).valid).toBeUndefined();
  });

  it("both routes verify through the one shared helper", () => {
    const src = (p: string) => readFileSync(join(__dirname, "..", "src/app/api/auth/password-reset", p, "route.ts"), "utf8");
    for (const route of ["check", "confirm"]) {
      const s = src(route);
      expect(s).toContain('from "@/lib/passwordResetCheck"');
      expect(s).toContain("await checkResetToken(");
      expect(s).not.toContain("verifyResetToken");
      expect(s).not.toContain("fingerprintMatches");
    }
    expect(src("confirm")).toContain("where: { id: user.id, passwordHash: user.passwordHash }");
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

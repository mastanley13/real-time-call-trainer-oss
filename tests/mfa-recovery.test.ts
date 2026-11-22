import crypto from "crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * MFA recovery codes: the pure helpers in mfaRecovery.ts and mfaRecovery-types.ts, and the routes that issue,
 * show, spend and delete them. The database is an in-memory stand-in whose updateMany honors its where clause in
 * one synchronous step, like a conditional UPDATE, so a lost race really returns count 0.
 */

type UserRow = { id: string; email: string; role: string; mfaEnabled: boolean; mfaSecret: string | null; mfaEnrolledAt: Date | null; passwordHash: string | null; lockedUntil: Date | null; googleSub: string | null };
type CodeRow = { id: string; userId: string; codeHash: string; usedAt: Date | null; createdAt: Date };
type Where = Record<string, unknown>;

const mocks = vi.hoisted(() => ({ verifyTotp: vi.fn((_secret: string, token: string) => token === "123456") }));

const state = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  codes: [] as CodeRow[],
  audits: [] as { action: string; userId?: string; metadata?: unknown }[],
  seq: 0,
}));

function matchCode(row: CodeRow, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

const fakeDb = vi.hoisted(() => {
  const db = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = state.users.get(where.id);
        return u ? { ...u, firstName: null, lastName: null, isPlatformAdmin: false, organization: null } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = state.users.get(where.id);
        if (!u) throw new Error("user not found");
        Object.assign(u, data);
        return { ...u };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<UserRow> }) => {
        const u = state.users.get(where.id as string);
        if (!u || Object.entries(where).some(([k, v]) => (u as unknown as Record<string, unknown>)[k] !== v)) return { count: 0 };
        Object.assign(u, data);
        return { count: 1 };
      },
    },
    mfaRecoveryCode: {
      deleteMany: async ({ where }: { where: Where }) => {
        const before = state.codes.length;
        state.codes = state.codes.filter((c) => !matchCode(c, where));
        return { count: before - state.codes.length };
      },
      createMany: async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
        for (const d of data) {
          if (state.codes.some((c) => c.codeHash === d.codeHash)) throw new Error("P2002 unique codeHash");
          state.codes.push({ id: `code-${++state.seq}`, usedAt: null, createdAt: new Date(), ...d });
        }
        return { count: data.length };
      },
      // Check and write in one step, with no await between them: the shape of UPDATE ... WHERE "usedAt" IS NULL.
      updateMany: async ({ where, data }: { where: Where; data: Partial<CodeRow> }) => {
        const hit = state.codes.filter((c) => matchCode(c, where));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      },
      count: async ({ where }: { where: Where }) => state.codes.filter((c) => matchCode(c, where)).length,
    },
    auditEvent: {
      create: async ({ data }: { data: { action: string; userId?: string; metadata?: unknown } }) => {
        state.audits.push(data);
        return data;
      },
    },
    $queryRaw: async (_s: TemplateStringsArray, userId: string) => {
      const u = state.users.get(userId);
      return u ? [{ mfaEnabled: u.mfaEnabled }] : [];
    },
    $transaction: async (arg: unknown) =>
      typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(db) : Promise.all(arg as Promise<unknown>[]),
  };
  return db;
});

vi.mock("@/lib/db", () => ({ prisma: fakeDb }));
vi.mock("@/lib/mfa", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/mfa")>()), verifyTotp: mocks.verifyTotp }));

import {
  RECOVERY_ALPHABET,
  RECOVERY_CODE_BITS,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "@/lib/mfaRecovery";
import { RECOVERY_CODE_COUNT, recoveryCodesFile, recoveryCodesLabel, recoveryCodesLow } from "@/lib/mfaRecovery-types";
import { hashPassword, signMfaChallengeToken, signSessionToken } from "@/lib/auth";
import { POST as activateRoute } from "@/app/api/auth/mfa/activate/route";
import { POST as challengeRoute } from "@/app/api/auth/mfa/challenge/route";
import { POST as disableRoute } from "@/app/api/auth/mfa/disable/route";
import { POST as enrollRoute } from "@/app/api/auth/mfa/enroll/route";
import { GET as countsRoute, POST as regenerateRoute } from "@/app/api/auth/mfa/recovery-codes/route";

const FORMAT = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const PASSWORD = "correct horse battery staple";
let passwordHash = "";
let ipSeq = 0;
let userSeq = 0;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-secret-0123456789abcdef0123456789");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  state.users.clear();
  state.codes = [];
  state.audits = [];
  mocks.verifyTotp.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A fresh user id per test, so per-user rate limit buckets never carry over. */
function seedUser(patch: Partial<UserRow> = {}): UserRow {
  const id = `u-${++userSeq}`;
  const u: UserRow = { id, email: `${id}@example.test`, role: "trainee", mfaEnabled: false, mfaSecret: "SECRET", mfaEnrolledAt: null, passwordHash, lockedUntil: null, googleSub: null, ...patch };
  state.users.set(id, u);
  return u;
}

function authed(url: string, user: UserRow, body?: unknown): NextRequest {
  const token = signSessionToken({ id: user.id, email: user.email, role: "trainee" });
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: `authToken=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function activate(user: UserRow, code = "123456") {
  return activateRoute(authed("http://localhost/api/auth/mfa/activate", user, { code }));
}

/** A signed-in user with MFA on and a set of recovery codes, plus the plaintext codes. */
async function enrolled(): Promise<{ user: UserRow; codes: string[] }> {
  const user = seedUser();
  const res = await activate(user);
  expect(res.status).toBe(200);
  return { user, codes: (await res.json()).recoveryCodes };
}

function challenge(userId: string, body: Record<string, string>, ip: string) {
  return challengeRoute(
    new NextRequest("http://localhost/api/auth/mfa/challenge", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ challengeToken: signMfaChallengeToken(userId), ...body }),
    }),
  );
}
const freshIp = () => `203.0.113.${++ipSeq}`;

function regenerate(user: UserRow, body: unknown) {
  return regenerateRoute(authed("http://localhost/api/auth/mfa/recovery-codes", user, body));
}

describe("recovery code generation", () => {
  it("issues 10 distinct codes formatted xxxx-xxxx-xxxx from the unambiguous alphabet", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(FORMAT);
  });

  it("uses a 32-symbol alphabet with no 0, 1, I or O, for at least 60 bits per code", () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_ALPHABET).size).toBe(32);
    expect(RECOVERY_ALPHABET).not.toMatch(/[01IO]/);
    expect(RECOVERY_CODE_BITS).toBeGreaterThanOrEqual(60);
  });

  it("draws its randomness from crypto.randomBytes", () => {
    const spy = vi.spyOn(crypto, "randomBytes");
    generateRecoveryCode();
    expect(spy).toHaveBeenCalledWith(12);
  });

  it("does not repeat across many codes and uses every symbol", () => {
    const many = Array.from({ length: 5000 }, generateRecoveryCode);
    expect(new Set(many).size).toBe(many.length);
    const seen = new Set(many.join("").replace(/-/g, ""));
    expect(seen.size).toBe(32);
  });
});

describe("normalization and hashing", () => {
  it("ignores case, spaces and dashes", () => {
    expect(normalizeRecoveryCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeRecoveryCode("  ABCD EFGH JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizeRecoveryCode("abcdefghjkmn")).toBe("ABCDEFGHJKMN");
    // En dash and Unicode hyphen, as some editors substitute them when pasting.
    const [enDash, hyphen] = [String.fromCharCode(0x2013), String.fromCharCode(0x2010)];
    expect(normalizeRecoveryCode(`ABCD${enDash}EFGH${hyphen}JKMN`)).toBe("ABCDEFGHJKMN");
  });

  it("rejects anything that cannot be a code", () => {
    for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKMNP", "ABCD-EFGH-JKM0", "ABCD-EFGH-JKMO", "ABCD-EFGH-JKM1", "ABCD-EFGH-JKMI", "ABCD_EFGH_JKM!"]) {
      expect(normalizeRecoveryCode(bad)).toBeNull();
    }
  });

  it("hashes to hex SHA-256 of the normalized form, the same for every way of typing it", () => {
    const h = hashRecoveryCode(normalizeRecoveryCode("abcd-efgh-jkmn")!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(crypto.createHash("sha256").update("ABCDEFGHJKMN").digest("hex"));
    expect(hashRecoveryCode(normalizeRecoveryCode("ABCD EFGH JKMN")!)).toBe(h);
    expect(h).not.toContain("ABCDEFGHJKMN");
  });
});

describe("display helpers", () => {
  it("labels the count and flags three or fewer as low", () => {
    expect(recoveryCodesLabel(7)).toBe("7 of 10 recovery codes left");
    expect(recoveryCodesLabel(1)).toBe("1 of 10 recovery code left");
    expect(recoveryCodesLabel(0)).toBe("No recovery codes left");
    expect(recoveryCodesLow(4)).toBe(false);
    expect(recoveryCodesLow(3)).toBe(true);
    expect(recoveryCodesLow(0)).toBe(true);
  });

  it("builds a plain text file with one code per line and the single-use note", () => {
    const file = recoveryCodesFile(["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"], { account: "rep@example.test", issuedAt: new Date("2026-11-22T10:00:00Z") });
    expect(file).toContain("Account: rep@example.test");
    expect(file).toContain("Issued: 2026-11-22");
    expect(file).toContain("Each code works once.");
    expect(file.split("\n")).toEqual(expect.arrayContaining(["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"]));
    expect(file).not.toContain(String.fromCharCode(0x2014)); // no em dash
  });
});

describe("activation", () => {
  it("turns MFA on and returns 10 codes once, storing only their hashes", async () => {
    const { user, codes } = await enrolled();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(FORMAT);
    expect(state.users.get(user.id)!.mfaEnabled).toBe(true);

    const rows = state.codes.filter((r) => r.userId === user.id);
    expect(rows).toHaveLength(10);
    const stored = JSON.stringify(state.codes);
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(normalizeRecoveryCode(c)!);
    }
    expect(rows.map((r) => r.codeHash).sort()).toEqual(codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c)!)).sort());
    const audit = state.audits.find((a) => a.action === "user.mfa_enabled");
    expect(audit?.metadata).toEqual({ recoveryCodesIssued: 10 });
    expect(JSON.stringify(state.audits)).not.toContain(codes[0]);
  });

  it("a wrong code issues nothing", async () => {
    const user = seedUser();
    const res = await activate(user, "000000");
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("recoveryCodes");
    expect(state.codes).toHaveLength(0);
  });

  it("refuses to activate twice, so activation cannot mint a second set", async () => {
    const { user } = await enrolled();
    const before = state.codes.map((c) => c.codeHash);
    const res = await activate(user);
    expect(res.status).toBe(400);
    expect(state.codes.map((c) => c.codeHash)).toEqual(before);
  });
});

describe("sign-in with a recovery code", () => {
  it("accepts a valid code once, writes an audit row without the code, then rejects reuse", async () => {
    const { user, codes } = await enrolled();
    const ip = freshIp();
    const ok = await challenge(user.id, { recoveryCode: codes[0] }, ip);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("authToken=");

    const used = state.audits.find((a) => a.action === "user.mfa_recovery_code_used");
    expect(used).toMatchObject({ userId: user.id, metadata: { remaining: 9 } });
    expect(JSON.stringify(state.audits)).not.toContain(codes[0]);
    expect(JSON.stringify(state.audits)).not.toContain(normalizeRecoveryCode(codes[0])!);
    expect(state.audits.find((a) => a.action === "user.mfa_challenge_success")?.metadata).toEqual({ method: "recovery_code" });

    const again = await challenge(user.id, { recoveryCode: codes[0] }, ip);
    expect(again.status).toBe(401);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(state.audits.filter((a) => a.action === "user.mfa_challenge_failed").at(-1)?.metadata).toEqual({ method: "recovery_code" });
  });

  it("normalizes what the user typed", async () => {
    const { user, codes } = await enrolled();
    const typed = ` ${codes[1].toLowerCase().replace(/-/g, " ")} `;
    expect((await challenge(user.id, { recoveryCode: typed }, freshIp())).status).toBe(200);
  });

  it("is single use under concurrent requests: exactly one of two racing sign-ins wins", async () => {
    const { user, codes } = await enrolled();
    const ip = freshIp();
    const results = await Promise.all([1, 2, 3].map(() => challenge(user.id, { recoveryCode: codes[2] }, ip)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
    expect(state.codes.filter((c) => c.usedAt).length).toBe(1);
  });

  it("does not accept another account's code", async () => {
    const a = await enrolled();
    const b = await enrolled();
    expect((await challenge(b.user.id, { recoveryCode: a.codes[0] }, freshIp())).status).toBe(401);
    expect(state.codes.every((c) => c.usedAt === null)).toBe(true);
  });

  it("still accepts an authenticator code, and refuses a body with both or neither", async () => {
    const { user, codes } = await enrolled();
    expect((await challenge(user.id, { code: "123456" }, freshIp())).status).toBe(200);
    expect((await challenge(user.id, { code: "123456", recoveryCode: codes[0] }, freshIp())).status).toBe(400);
    expect((await challenge(user.id, {}, freshIp())).status).toBe(400);
  });

  it("shares the TOTP limiter: failed recovery and TOTP attempts count together, and the limit blocks both", async () => {
    const { user, codes } = await enrolled();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await challenge(user.id, i % 2 ? { code: "000000" } : { recoveryCode: "AAAA-AAAA-AAAA" }, ip);
      expect(res.status).toBe(401);
    }
    // The 11th attempt in the window is refused before any code is checked, even a valid recovery code.
    const blockedRecovery = await challenge(user.id, { recoveryCode: codes[0] }, ip);
    expect(blockedRecovery.status).toBe(429);
    expect((await challenge(user.id, { code: "123456" }, ip)).status).toBe(429);
    expect(state.codes.every((c) => c.usedAt === null)).toBe(true);
    expect(state.audits.filter((a) => a.action === "user.mfa_challenge_failed")).toHaveLength(10);
  });
});

describe("regenerating codes", () => {
  it("requires a signed-in user", async () => {
    const res = await regenerateRoute(new NextRequest("http://localhost/api/auth/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ password: PASSWORD }) }));
    expect(res.status).toBe(401);
  });

  it("requires exactly one proof: a password or an authenticator code", async () => {
    const { user } = await enrolled();
    expect((await regenerate(user, {})).status).toBe(400);
    expect((await regenerate(user, { password: PASSWORD, code: "123456" })).status).toBe(400);
  });

  it("a wrong password or code changes nothing", async () => {
    const { user, codes } = await enrolled();
    const before = state.codes.map((c) => c.codeHash);
    const wrongPw = await regenerate(user, { password: "not it" });
    expect(wrongPw.status).toBe(401);
    expect(await wrongPw.json()).not.toHaveProperty("recoveryCodes");
    expect((await regenerate(user, { code: "000000" })).status).toBe(401);
    expect(state.codes.map((c) => c.codeHash)).toEqual(before);
    expect(state.audits.filter((a) => a.action === "user.mfa_recovery_codes_regenerate_failed")).toHaveLength(2);
    expect((await challenge(user.id, { recoveryCode: codes[0] }, freshIp())).status).toBe(200);
  });

  it("with the password: returns 10 new codes and every old code stops working", async () => {
    const { user, codes: old } = await enrolled();
    const res = await regenerate(user, { password: PASSWORD });
    expect(res.status).toBe(200);
    const { recoveryCodes: fresh } = await res.json();
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c: string) => old.includes(c))).toBe(false);
    expect(state.codes.filter((c) => c.userId === user.id)).toHaveLength(10);

    const ip = freshIp();
    expect((await challenge(user.id, { recoveryCode: old[0] }, ip)).status).toBe(401);
    expect((await challenge(user.id, { recoveryCode: fresh[0] }, ip)).status).toBe(200);
    expect(state.audits.find((a) => a.action === "user.mfa_recovery_codes_regenerated")?.metadata).toEqual({ method: "password", issued: 10 });
  });

  it("with an authenticator code", async () => {
    const { user } = await enrolled();
    const res = await regenerate(user, { code: "123456" });
    expect(res.status).toBe(200);
    expect(mocks.verifyTotp).toHaveBeenLastCalledWith("SECRET", "123456");
  });

  it("a Google-only account (no password) must use the authenticator code", async () => {
    const { user } = await enrolled();
    state.users.get(user.id)!.passwordHash = null;
    expect((await regenerate(user, { password: PASSWORD })).status).toBe(401);
    expect((await regenerate(user, { code: "123456" })).status).toBe(200);
  });

  it("is refused while MFA is off", async () => {
    const user = seedUser();
    const res = await regenerate(user, { password: PASSWORD });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("mfa_not_enabled");
    expect(state.codes).toHaveLength(0);
  });

  it("is rate limited per user", async () => {
    const { user } = await enrolled();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await regenerate(user, { code: "000000" })).status);
    expect(statuses.slice(0, 6).every((s) => s === 401)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});

describe("remaining count", () => {
  it("reports unused and issued codes, never the codes", async () => {
    const { user, codes } = await enrolled();
    await challenge(user.id, { recoveryCode: codes[0] }, freshIp());
    const res = await countsRoute(authed("http://localhost/api/auth/mfa/recovery-codes", user));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remaining: 9, total: 10 });
  });
});

describe("disabling MFA", () => {
  it("deletes every recovery code", async () => {
    const { user, codes } = await enrolled();
    const other = await enrolled();
    const res = await disableRoute(authed("http://localhost/api/auth/mfa/disable", user, { code: "123456" }));
    expect(res.status).toBe(200);
    expect(state.codes.filter((c) => c.userId === user.id)).toHaveLength(0);
    expect(state.codes.filter((c) => c.userId === other.user.id)).toHaveLength(10);
    expect(state.users.get(user.id)).toMatchObject({ mfaEnabled: false, mfaSecret: null });
    // MFA is off, so the challenge itself is refused and the old code cannot be used anywhere.
    expect((await challenge(user.id, { recoveryCode: codes[0] }, freshIp())).status).toBe(400);
  });

  it("a wrong code deletes nothing", async () => {
    const { user } = await enrolled();
    expect((await disableRoute(authed("http://localhost/api/auth/mfa/disable", user, { code: "000000" }))).status).toBe(401);
    expect(state.codes.filter((c) => c.userId === user.id)).toHaveLength(10);
  });
});

describe("demo mode and database-free installs", () => {
  it.each([
    ["demo mode", { DEMO_MODE: "true" }],
    ["no database", { DATABASE_URL: "" }],
  ] as [string, Record<string, string>][])("%s: every signed-in MFA route answers 503 mfa_not_available", async (_n, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const user = seedUser();
    const responses = [
      await regenerate(user, { password: PASSWORD }),
      await countsRoute(authed("http://localhost/api/auth/mfa/recovery-codes", user)),
      await activate(user),
      await disableRoute(authed("http://localhost/api/auth/mfa/disable", user, { code: "123456" })),
      await enrollRoute(authed("http://localhost/api/auth/mfa/enroll", user, {})),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("mfa_not_available");
    }
    expect(state.codes).toHaveLength(0);
  });
});

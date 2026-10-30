import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// The database (an in-memory fake that understands the where clauses the routes send), the session check and
// the rate limiters are the only fakes; the invite helpers, the gate and every route run for real.
type Invite = {
  id: string; codeHash: string; label: string; maxRedemptions: number | null; redemptionCount: number;
  expiresAt: Date | null; revokedAt: Date | null; minuteQuota: number | null; createdById: string | null; createdAt: Date;
};
type User = { id: string; email: string; isPlatformAdmin: boolean; inviteCodeId: string | null; [k: string]: unknown };

const FIELD = { maxRedemptions: { __field: "maxRedemptions" } };

const mocks = vi.hoisted(() => ({
  user: { id: "u-1", email: "u-1@example.test" } as { id: string; email: string },
  invites: [] as Invite[],
  users: [] as User[],
  audit: [] as { action: string; resource?: string; userId?: string }[],
  prisma: {} as Record<string, unknown>,
}));

type Where = Record<string, unknown>;
function resolve(row: Record<string, unknown>, v: unknown): unknown {
  return v && typeof v === "object" && "__field" in v ? row[(v as { __field: string }).__field] : v;
}
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as Where[]).every((w) => matches(row, w));
    if (k === "OR") return (v as Where[]).some((w) => matches(row, w));
    if (v === null) return row[k] === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const cond = v as { gt?: unknown; lt?: unknown };
      const cur = row[k] as number | Date | null;
      if (cur === null || cur === undefined) return false;
      if ("gt" in cond && !(cur > (resolve(row, cond.gt) as number | Date))) return false;
      if ("lt" in cond) {
        const bound = resolve(row, cond.lt);
        if (bound === null || !(cur < (bound as number | Date))) return false;
      }
      return true;
    }
    return row[k] === v;
  });
}
const pick = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
function applyData(row: Record<string, unknown>, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] as number) + (v as { increment: number }).increment;
    else row[k] = v;
  }
}

Object.assign(mocks.prisma, {
  inviteCode: {
    fields: FIELD,
    findUnique: vi.fn(async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
      const row = mocks.invites.find((r) => matches(r, where));
      return row ? pick(row, select) : null;
    }),
    findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> }) => mocks.invites.map((r) => pick(r, select))),
    create: vi.fn(async ({ data, select }: { data: Partial<Invite>; select?: Record<string, boolean> }) => {
      const row: Invite = { id: `inv${mocks.invites.length + 1}`, redemptionCount: 0, revokedAt: null, createdAt: new Date(), maxRedemptions: null, expiresAt: null, minuteQuota: null, createdById: null, codeHash: "", label: "", ...data };
      mocks.invites.push(row);
      return pick(row, select);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const rows = mocks.invites.filter((r) => matches(r, where));
      rows.forEach((r) => applyData(r, data));
      return { count: rows.length };
    }),
  },
  user: {
    findUnique: vi.fn(async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
      const row = mocks.users.find((u) => matches(u, where));
      return row ? pick(row, select) : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const rows = mocks.users.filter((u) => matches(u, where));
      rows.forEach((r) => applyData(r, data));
      return { count: rows.length };
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `u${mocks.users.length + 100}`, isPlatformAdmin: false, inviteCodeId: null, ...data } as User;
      mocks.users.push(row);
      return { ...row, organization: { id: "o-1", name: "Harbor Point", code: "123" } };
    }),
  },
  organization: { findUnique: vi.fn(async () => ({ id: "o-1", name: "Harbor Point", code: "123" })) },
  auditEvent: { create: vi.fn(async ({ data }: { data: { action: string; resource?: string; userId?: string } }) => { mocks.audit.push(data); return data; }) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mocks.prisma)),
});

vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: (u: { id: string }) => u.id === "demo-user" }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  ipLimitResponse: vi.fn(() => null),
  userLimitResponse: vi.fn(() => null),
  rateLimit: vi.fn(() => ({ allowed: true, remaining: 9, retryAfterMs: 0 })),
}));

import { ipLimitResponse } from "@/lib/rateLimit";
import { ACCESS_COOKIE, accessGateEnabled, accessToken, gateCookieValid, inviteAccessToken, verifyInviteAccessToken } from "@/lib/access";
import { consumeInvite, generateInviteCode, hashInviteCode, inviteStatus, normalizeInviteCode } from "@/lib/invites";
import { POST as accessPost } from "@/app/api/access/route";
import { POST as redeemPost } from "@/app/api/invites/redeem/route";
import { GET as adminList, POST as adminCreate } from "@/app/api/admin/invites/route";
import { DELETE as adminRevoke } from "@/app/api/admin/invites/[id]/route";
import { POST as registerPost } from "@/app/api/auth/register/route";
import { middleware } from "@/middleware";

const JSON_HEADERS = { "content-type": "application/json" };
const post = (url: string, body: unknown, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) } });
const DAY = 86_400_000;
/** The gate cookie a route set. Routes can return a plain Response (the 429 path), so narrow first. */
const gateCookie = (res: Response) => (res as NextResponse).cookies.get(ACCESS_COOKIE);

const ENV_KEYS = ["DATABASE_URL", "DEMO_MODE", "JWT_SECRET", "TRAINER_ACCESS_CODE", "ALLOW_SHARED_ACCESS_CODE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** Adds an invite and returns its plain code. */
function addInvite(over: Partial<Invite> = {}): { code: string; invite: Invite } {
  const code = generateInviteCode();
  const invite: Invite = {
    id: `inv${mocks.invites.length + 1}`, codeHash: hashInviteCode(code), label: "Test invite", maxRedemptions: null, redemptionCount: 0,
    expiresAt: null, revokedAt: null, minuteQuota: null, createdById: "admin-1", createdAt: new Date(), ...over,
  };
  mocks.invites.push(invite);
  return { code, invite };
}
const signIn = (id: string, isPlatformAdmin = false) => {
  mocks.user = { id, email: `${id}@example.test` };
  if (!mocks.users.some((u) => u.id === id)) mocks.users.push({ id, email: mocks.user.email, isPlatformAdmin, inviteCodeId: null });
};

beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  process.env.JWT_SECRET = "test-secret-not-real-0123456789abcdef0123";
  delete process.env.DEMO_MODE;
  delete process.env.TRAINER_ACCESS_CODE;
  delete process.env.ALLOW_SHARED_ACCESS_CODE;
  mocks.invites.length = 0;
  mocks.users.length = 0;
  mocks.audit.length = 0;
  signIn("u-1");
});
afterEach(() => {
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
});

describe("invite code helpers", () => {
  it("generates readable, unique codes and hashes them without keeping the plain code", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    expect(generateInviteCode()).not.toBe(code);
    const hash = hashInviteCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeInviteCode(code));
    expect(hash.toUpperCase()).not.toContain(normalizeInviteCode(code));
    // Case, spaces and dashes don't matter.
    expect(hashInviteCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(hash);
    expect(hashInviteCode(code.slice(0, -1) + (code.endsWith("0") ? "1" : "0"))).not.toBe(hash);
  });

  it("works out an invite's status", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const base = { maxRedemptions: null, redemptionCount: 0, expiresAt: null, revokedAt: null };
    expect(inviteStatus(base, now)).toBe("active");
    expect(inviteStatus({ ...base, revokedAt: now }, now)).toBe("revoked");
    expect(inviteStatus({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(inviteStatus({ ...base, maxRedemptions: 2, redemptionCount: 2 }, now)).toBe("exhausted");
    expect(inviteStatus({ ...base, maxRedemptions: 2, redemptionCount: 1 }, now)).toBe("active");
  });

  it("consumes with a conditional update that compares the count with the cap in the database", async () => {
    const { invite } = addInvite({ maxRedemptions: 1 });
    const db = mocks.prisma as unknown as Parameters<typeof consumeInvite>[0];
    const [a, b] = await Promise.all([consumeInvite(db, invite.id), consumeInvite(db, invite.id)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(invite.redemptionCount).toBe(1);
    const where = (mocks.prisma.inviteCode as { updateMany: { mock: { calls: [{ where: unknown }][] } } }).updateMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"revokedAt":null');
    expect(where).toMatchObject({ AND: expect.arrayContaining([{ OR: [{ maxRedemptions: null }, { redemptionCount: { lt: FIELD.maxRedemptions } }] }]) });
  });

  it("signs invite gate cookies and rejects tampered or expired ones", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = (await inviteAccessToken("inv1", exp))!;
    expect(token.startsWith("inv.inv1.")).toBe(true);
    expect(await verifyInviteAccessToken(token)).toBe("inv1");
    expect(await verifyInviteAccessToken(token.replace("inv.inv1.", "inv.inv2."))).toBeNull();
    expect(await verifyInviteAccessToken(token, (exp + 1) * 1000)).toBeNull();
    process.env.JWT_SECRET = "test-secret-a-different-one-0123456789abcd";
    expect(await verifyInviteAccessToken(token)).toBeNull();
    delete process.env.JWT_SECRET;
    expect(await inviteAccessToken("inv1", exp)).toBeNull();
  });
});

describe("legacy shared code behind ALLOW_SHARED_ACCESS_CODE", () => {
  const SHARED = "test-shared-code-not-real";

  it("keeps the shared code working by default", async () => {
    process.env.TRAINER_ACCESS_CODE = SHARED;
    expect(accessGateEnabled()).toBe(true);
    const res = await accessPost(post("/api/access", { code: SHARED }));
    expect(res.status).toBe(200);
    const cookie = gateCookie(res)!.value;
    expect(cookie).toBe(await accessToken(SHARED));
    expect(cookie).not.toContain(SHARED);
    expect(await gateCookieValid(cookie)).toBe(true);
    expect(ipLimitResponse).toHaveBeenCalledWith(expect.anything(), "access");
  });

  it("refuses the shared code and its old cookies once the flag is false, and keeps the gate on", async () => {
    process.env.TRAINER_ACCESS_CODE = SHARED;
    const oldCookie = await accessToken(SHARED);
    process.env.ALLOW_SHARED_ACCESS_CODE = "false";
    const res = await accessPost(post("/api/access", { code: SHARED }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_code" });
    expect(await gateCookieValid(oldCookie)).toBe(false);

    const blocked = await middleware(new NextRequest("http://localhost/api/config", { headers: { cookie: `${ACCESS_COOKIE}=${oldCookie}` } }));
    expect(blocked.status).toBe(401);

    // Invite-only with no shared code at all: the gate stays on.
    delete process.env.TRAINER_ACCESS_CODE;
    expect(accessGateEnabled()).toBe(true);
  });

  it("has no gate when no shared code is set and the flag is left alone", async () => {
    expect(accessGateEnabled()).toBe(false);
    const res = await middleware(new NextRequest("http://localhost/api/config"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("invite codes at the gate", () => {
  beforeEach(() => {
    process.env.TRAINER_ACCESS_CODE = "test-shared-code-not-real";
  });

  it("lets an active invite through with a signed cookie, without using up a redemption", async () => {
    const { code, invite } = addInvite({ maxRedemptions: 1 });
    const res = await accessPost(post("/api/access", { code }));
    expect(res.status).toBe(200);
    const cookie = gateCookie(res)!;
    expect(await verifyInviteAccessToken(cookie.value)).toBe(invite.id);
    expect(cookie.maxAge).toBeLessThanOrEqual(7 * 86_400);
    expect(invite.redemptionCount).toBe(0);

    const through = await middleware(new NextRequest("http://localhost/api/config", { headers: { cookie: `${ACCESS_COOKIE}=${cookie.value}` } }));
    expect(through.headers.get("x-middleware-next")).toBe("1");
  });

  it("works for invites when the shared code is switched off", async () => {
    process.env.ALLOW_SHARED_ACCESS_CODE = "false";
    const { code } = addInvite();
    expect((await accessPost(post("/api/access", { code }))).status).toBe(200);
  });

  it.each([
    ["revoked", { revokedAt: new Date(Date.now() - 1000) }],
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
    ["used up", { maxRedemptions: 2, redemptionCount: 2 }],
  ])("refuses a %s invite with the same generic error", async (_name, over) => {
    const { code } = addInvite(over);
    const res = await accessPost(post("/api/access", { code }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_code", message: "That code isn't right. Check it and try again." });
  });

  it("does not look up invites without a database, and the shared code still works", async () => {
    delete process.env.DATABASE_URL;
    const { code } = addInvite();
    expect((await accessPost(post("/api/access", { code }))).status).toBe(401);
    expect((await accessPost(post("/api/access", { code: "test-shared-code-not-real" }))).status).toBe(200);
  });

  it("caps the gate cookie at the invite's expiry", async () => {
    const { code } = addInvite({ expiresAt: new Date(Date.now() + 3600_000) });
    const res = await accessPost(post("/api/access", { code }));
    expect(gateCookie(res)!.maxAge).toBeLessThanOrEqual(3600);
  });
});

describe("POST /api/invites/redeem", () => {
  const redeem = (code: string) => redeemPost(post("/api/invites/redeem", { code }));

  it("links the signed-in account and counts the redemption", async () => {
    const { code, invite } = addInvite({ maxRedemptions: 3 });
    const res = await redeem(code);
    expect(res.status).toBe(200);
    expect(mocks.users.find((u) => u.id === "u-1")!.inviteCodeId).toBe(invite.id);
    expect(invite.redemptionCount).toBe(1);
    expect(mocks.audit).toContainEqual(expect.objectContaining({ action: "invite.redeemed", resource: invite.id, userId: "u-1" }));
    expect(await verifyInviteAccessToken(gateCookie(res)!.value)).toBe(invite.id);
  });

  it.each([
    ["revoked", { revokedAt: new Date(Date.now() - DAY) }],
    ["expired", { expiresAt: new Date(Date.now() - DAY) }],
    ["used up", { maxRedemptions: 1, redemptionCount: 1 }],
  ])("refuses a %s invite and links nothing", async (_name, over) => {
    const { code, invite } = addInvite(over);
    const before = invite.redemptionCount;
    const res = await redeem(code);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_invite" });
    expect(mocks.users.find((u) => u.id === "u-1")!.inviteCodeId).toBeNull();
    expect(invite.redemptionCount).toBe(before);
  });

  it("refuses an unknown code", async () => {
    const res = await redeem("NOPE-NOPE-NOPE-NOPE-NOPE");
    expect(res.status).toBe(400);
  });

  it("takes the last slot once when two accounts race for it", async () => {
    const { code, invite } = addInvite({ maxRedemptions: 1 });
    signIn("u-2");
    const r2 = redeemPost(post("/api/invites/redeem", { code }));
    signIn("u-1");
    const r1 = redeemPost(post("/api/invites/redeem", { code }));
    const statuses = (await Promise.all([r1, r2])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
    expect(invite.redemptionCount).toBe(1);
  });

  it("answers 409 when the account is already linked", async () => {
    const { code } = addInvite();
    mocks.users.find((u) => u.id === "u-1")!.inviteCodeId = "inv-old";
    const res = await redeem(code);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_redeemed" });
  });

  it("answers 503 without a database or in demo mode", async () => {
    const { code } = addInvite();
    delete process.env.DATABASE_URL;
    expect(await (await redeem(code)).json()).toMatchObject({ error: "invites_not_configured" });
    process.env.DATABASE_URL = "postgresql://test@localhost/test";
    process.env.DEMO_MODE = "true";
    expect((await redeem(code)).status).toBe(503);
  });

  it("rejects a bad body", async () => {
    expect((await redeemPost(post("/api/invites/redeem", { code: "" }))).status).toBe(400);
    expect((await redeemPost(post("/api/invites/redeem", { code: "x".repeat(201) }))).status).toBe(400);
  });
});

describe("registration with an invite", () => {
  const register = (extra: Record<string, unknown>, cookie?: string) =>
    registerPost(post("/api/auth/register", { firstName: "Sam", lastName: "Lee", email: `sam${mocks.users.length}@example.test`, password: "test-password-123", joinOrgCode: "123", ...extra }, cookie));

  it("creates the account linked to the invite and counts it", async () => {
    const { code, invite } = addInvite({ maxRedemptions: 2 });
    const res = await register({ inviteCode: code });
    expect(res.status).toBe(200);
    expect(mocks.users.at(-1)!.inviteCodeId).toBe(invite.id);
    expect(invite.redemptionCount).toBe(1);
  });

  it("uses the invite from the gate cookie when no code is sent", async () => {
    const { invite } = addInvite();
    const token = (await inviteAccessToken(invite.id, Math.floor(Date.now() / 1000) + 3600))!;
    const res = await register({}, `${ACCESS_COOKIE}=${token}`);
    expect(res.status).toBe(200);
    expect(mocks.users.at(-1)!.inviteCodeId).toBe(invite.id);
  });

  it("creates no account when the invite is used up", async () => {
    const { code } = addInvite({ maxRedemptions: 1, redemptionCount: 1 });
    const res = await register({ inviteCode: code });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_invite" });
    expect(mocks.users.some((u) => String(u.email).startsWith("sam"))).toBe(false);
  });

  it("still registers without any invite", async () => {
    const res = await register({});
    expect(res.status).toBe(200);
    expect(mocks.users.at(-1)!.inviteCodeId).toBeNull();
  });
});

describe("admin invite routes", () => {
  const create = (body: unknown) => adminCreate(post("/api/admin/invites", body));
  const list = () => adminList(new NextRequest("http://localhost/api/admin/invites"));
  const revoke = (id: string) => adminRevoke(new NextRequest(`http://localhost/api/admin/invites/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

  it("lets a platform admin create a code, shown once, with only its hash stored", async () => {
    signIn("admin-1", true);
    const res = await create({ label: "Acme pilot, Jordan", maxRedemptions: 5, minuteQuota: 120, expiresAt: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; invite: Record<string, unknown> };
    const stored = mocks.invites[0];
    expect(stored.codeHash).toBe(hashInviteCode(body.code));
    expect(Object.values(stored).map(String)).not.toContain(body.code);
    expect(JSON.stringify(stored)).not.toContain(normalizeInviteCode(body.code));
    expect(stored).toMatchObject({ label: "Acme pilot, Jordan", maxRedemptions: 5, minuteQuota: 120, createdById: "admin-1" });
    expect(body.invite).not.toHaveProperty("codeHash");
    expect(body.invite.status).toBe("active");
    expect(mocks.audit).toContainEqual(expect.objectContaining({ action: "invite.created" }));
  });

  it("lists invites with no codes or hashes", async () => {
    signIn("admin-1", true);
    addInvite({ revokedAt: new Date() });
    addInvite();
    const res = await list();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("codeHash");
    for (const inv of mocks.invites) expect(text).not.toContain(inv.codeHash);
    const body = JSON.parse(text) as { invites: { status: string }[] };
    expect(body.invites.map((i) => i.status)).toEqual(["revoked", "active"]);
  });

  it("revokes an invite, which then stops working at the gate and for redemption", async () => {
    signIn("admin-1", true);
    const { code, invite } = addInvite();
    const res = await revoke(invite.id);
    expect(res.status).toBe(200);
    expect(invite.revokedAt).toBeInstanceOf(Date);
    expect(mocks.audit).toContainEqual(expect.objectContaining({ action: "invite.revoked", resource: invite.id }));
    // Revoking again keeps the first time and writes no second audit row.
    const first = invite.revokedAt;
    await revoke(invite.id);
    expect(invite.revokedAt).toBe(first);
    expect(mocks.audit.filter((a) => a.action === "invite.revoked")).toHaveLength(1);

    process.env.TRAINER_ACCESS_CODE = "test-shared-code-not-real";
    expect((await accessPost(post("/api/access", { code }))).status).toBe(401);
    signIn("u-1");
    expect((await redeemPost(post("/api/invites/redeem", { code }))).status).toBe(400);
  });

  it("answers 404 for an unknown invite", async () => {
    signIn("admin-1", true);
    expect((await revoke("inv-missing")).status).toBe(404);
  });

  it("refuses everyone who isn't a platform admin, whatever the session says", async () => {
    signIn("owner-1", false);
    const { invite } = addInvite();
    for (const res of [await list(), await create({ label: "Nope" }), await revoke(invite.id)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
    expect(invite.revokedAt).toBeNull();
    expect(mocks.invites).toHaveLength(1);
  });

  it("never treats the demo user as an admin", async () => {
    signIn("demo-user", true);
    expect((await list()).status).toBe(403);
    expect((await create({ label: "Nope" })).status).toBe(403);
  });

  it("answers 503 invites_not_configured in demo mode or without a database", async () => {
    signIn("admin-1", true);
    process.env.DEMO_MODE = "true";
    expect(await (await list()).json()).toMatchObject({ error: "invites_not_configured" });
    delete process.env.DEMO_MODE;
    delete process.env.DATABASE_URL;
    expect((await create({ label: "Pilot" })).status).toBe(503);
  });

  it("validates the create body", async () => {
    signIn("admin-1", true);
    expect((await create({})).status).toBe(400);
    expect((await create({ label: "x".repeat(121) })).status).toBe(400);
    expect((await create({ label: "Pilot", maxRedemptions: 0 })).status).toBe(400);
    expect((await create({ label: "Pilot", codeHash: "abc" })).status).toBe(400);
    const past = await create({ label: "Pilot", expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({ error: "invalid_expiry" });
    expect(mocks.invites).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CustomScenario, User } from "@prisma/client";
import { newBlankScenario } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";

const mocks = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  prisma: {
    user: { findUnique: vi.fn() },
    customScenario: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(), $queryRaw: vi.fn(),
  },
  ipLimitResponse: vi.fn(), userLimitResponse: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", async () => {
  const { NextResponse } = await import("next/server");
  return { requireAuth: () => mocks.user ?? NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
});
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rateLimit")>(),
  ipLimitResponse: mocks.ipLimitResponse, userLimitResponse: mocks.userLimitResponse,
}));

import { GET as list, POST } from "@/app/api/scenarios/route";
import { GET, PUT, DELETE } from "@/app/api/scenarios/[id]/route";
import { IP_LIMITS, USER_LIMITS, MAX_BODY_BYTES } from "@/lib/rateLimit";

type Actor = Pick<User, "id" | "organizationId" | "role" | "isPlatformAdmin">;
const T0 = new Date("2026-11-24T12:00:00.000Z");
const scenario = { ...newBlankScenario(), id: "custom-example", title: "Fictional practice" };
let actor: Actor | null;
let rows: CustomScenario[];

function signIn(id: string, role: Actor["role"] = "trainee", organizationId: string | null = "org-1", isPlatformAdmin = false) {
  actor = { id, role, organizationId, isPlatformAdmin };
  mocks.user = { id, email: `${id}@example.test` };
}

function fixture(id: string, userId: string, organizationId: string | null, sharedWithOrg: boolean): CustomScenario {
  return {
    id, userId, organizationId, sharedWithOrg, keepRealNames: true, sourceUrl: null,
    title: scenario.title, role: scenario.role, industry: scenario.industry, difficulty: scenario.difficulty, callType: scenario.callType,
    data: { ...scenario, id, builtIn: false }, createdAt: T0, updatedAt: T0,
  };
}

const req = (method = "GET", body?: unknown) => new NextRequest("http://localhost/api/scenarios", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
const params = (id = scenario.id) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown = { scenario }) => POST(req("POST", body));
const get = (id = scenario.id) => GET(req(), params(id));
const put = (body: unknown = { scenario }, id = scenario.id) => PUT(req("PUT", body), params(id));
const remove = (id = scenario.id) => DELETE(req("DELETE"), params(id));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("RATE_LIMIT_SCENARIOS_MAX", "");
  vi.stubEnv("RATE_LIMIT_SCENARIOS_WINDOW_SEC", "");
  signIn("rep-1");
  rows = [fixture(scenario.id, "rep-1", "org-1", false)];
  const db = mocks.prisma;
  db.user.findUnique.mockImplementation(async ({ where }) => actor?.id === where.id ? actor : null);
  db.$transaction.mockImplementation(async (fn) => fn(db));
  db.$queryRaw.mockResolvedValue([{ locked: 1 }]);
  db.customScenario.findUnique.mockImplementation(async ({ where }) => rows.find((row) => row.id === where.id) ?? null);
  db.customScenario.findMany.mockImplementation(async ({ where, take }) => rows.filter((row) =>
    where.OR.some((scope: Partial<CustomScenario>) => Object.entries(scope).every(([key, value]) => row[key as keyof CustomScenario] === value)),
  ).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, take));
  db.customScenario.count.mockImplementation(async ({ where }) => rows.filter((row) => row.userId === where.userId).length);
  db.customScenario.create.mockImplementation(async ({ data }) => {
    const row = { ...data, createdAt: T0 };
    rows.push(row);
    return row;
  });
  db.customScenario.update.mockImplementation(async ({ where, data }) => {
    const row = rows.find((item) => item.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
  db.customScenario.delete.mockImplementation(async ({ where }) => {
    const index = rows.findIndex((row) => row.id === where.id);
    return rows.splice(index, 1)[0];
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("authentication and persistence", () => {
  it("requires authentication before any database calls or rate limits", async () => {
    mocks.user = null;
    for (const res of [await list(req()), await get(), await post(), await put(), await remove()]) expect(res.status).toBe(401);
    expect(mocks.ipLimitResponse).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["demo", "no-db"])("falls back to local persistence (%s) without querying Prisma", async (mode) => {
    if (mode === "demo") vi.stubEnv("DEMO_MODE", "true");
    else vi.stubEnv("DATABASE_URL", "");
    expect(await (await list(req())).json()).toEqual({ scenarios: [], persistence: "local" });
    for (const res of [await post(), await get(), await put(), await remove()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "database_not_configured" });
    }
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects stale accounts", async () => {
    actor = null;
    for (const res of [await list(req()), await get(), await post(), await put(), await remove()]) expect(res.status).toBe(401);
  });
});

describe("database listing and individual authorization", () => {
  it("lists only own and shared same-org rows, newest first, at most 200", async () => {
    rows.push(fixture("shared", "rep-2", "org-1", true), fixture("private", "rep-2", "org-1", false), fixture("other-org", "rep-3", "org-2", true));
    rows[1].updatedAt = new Date(T0.getTime() + 1);
    const res = await list(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persistence).toBe("database");
    expect(body.scenarios.map((item: { id: string; canEdit: boolean }) => [item.id, item.canEdit])).toEqual([["shared", false], [scenario.id, true]]);
    expect(mocks.prisma.customScenario.findMany).toHaveBeenCalledWith({ where: { OR: [{ userId: "rep-1" }, { organizationId: "org-1", sharedWithOrg: true }] }, orderBy: { updatedAt: "desc" }, take: 200 });
  });

  it.each([
    ["rep-1", "trainee", "org-1", false, false, 200, true],
    ["rep-2", "trainee", "org-1", false, false, 404, false],
    ["rep-2", "trainee", "org-1", false, true, 200, false],
    ["manager", "manager", "org-1", false, false, 200, false],
    ["manager", "manager", "org-1", false, true, 200, true],
    ["org-owner", "owner", "org-1", false, true, 200, true],
    ["manager", "manager", "org-2", false, true, 404, false],
    ["admin", "trainee", null, true, false, 200, true],
  ] as const)("applies row scope for %s (%s, org=%s, admin=%s, shared=%s)", async (id, role, org, admin, shared, status, canEdit) => {
    signIn(id, role, org, admin);
    rows[0].sharedWithOrg = shared;
    const res = await get();
    expect(res.status).toBe(status);
    if (status === 200) expect(await res.json()).toMatchObject({ item: { canEdit } });
    expect((await put()).status).toBe(canEdit ? 200 : status === 404 ? 404 : 403);
    expect((await remove()).status).toBe(canEdit ? 200 : status === 404 ? 404 : 403);
  });

  it("never treats null organization ids as shared membership", async () => {
    rows[0].organizationId = null;
    rows[0].sharedWithOrg = true;
    signIn("other", "manager", null);
    expect((await get()).status).toBe(404);
    expect(await (await list(req())).json()).toEqual({ scenarios: [], persistence: "database" });
  });
});

describe("writes", () => {
  it("creates and upserts the same owner's validated custom persona without increasing the row count", async () => {
    rows = [];
    const created = await post({ scenario: { ...scenario, builtIn: true }, sourceUrl: "https://EXAMPLE.test/product#details", keepRealNames: false });
    expect(created.status).toBe(201);
    const { item } = await created.json();
    expect(item).toMatchObject({ userId: "rep-1", organizationId: "org-1", sharedWithOrg: false, keepRealNames: false, sourceUrl: "https://example.test/product", scenario: { builtIn: false, status: "draft" }, canEdit: true });
    expect(rows[0]).toMatchObject({ id: scenario.id, title: scenario.title, role: scenario.role, industry: scenario.industry, difficulty: scenario.difficulty, callType: scenario.callType });
    expect((await post({ scenario: { ...scenario, title: "Updated" } })).status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Updated", keepRealNames: false, sourceUrl: "https://example.test/product" });
  });

  it("rejects built-in and other-owner ids, including for an admin", async () => {
    expect((await post({ scenario: LIBRARY[0] })).status).toBe(409);
    signIn("other", "manager", "org-1", true);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "id_conflict" });
    expect(mocks.prisma.customScenario.update).not.toHaveBeenCalled();
  });

  it("caps new rows but permits existing-owner saves at the cap", async () => {
    mocks.prisma.customScenario.count.mockResolvedValue(100);
    const res = await post({ scenario: { ...scenario, id: "custom-new" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "scenario_limit" });
    expect(mocks.prisma.customScenario.create).not.toHaveBeenCalled();
    expect((await post()).status).toBe(201);
  });

  it("allows explicit sharing only for managers/owners or admins with an organization", async () => {
    expect((await post({ scenario, sharedWithOrg: true })).status).toBe(403);
    expect((await put({ scenario, sharedWithOrg: true })).status).toBe(403);
    signIn("rep-1", "owner", null);
    expect((await post({ scenario, sharedWithOrg: true })).status).toBe(403);
    signIn("rep-1", "manager");
    expect((await post({ scenario, sharedWithOrg: true })).status).toBe(201);
    expect(rows[0].sharedWithOrg).toBe(true);
    signIn("rep-2", "manager");
    expect((await put({ scenario, sharedWithOrg: false })).status).toBe(200);
    expect(rows[0]).toMatchObject({ sharedWithOrg: false, userId: "rep-1", organizationId: "org-1" });
    signIn("rep-1", "trainee", "org-1", true);
    expect((await put({ scenario, sharedWithOrg: true })).status).toBe(200);
  });

  it("does not carry a previous org share into a new organization implicitly", async () => {
    rows[0].sharedWithOrg = true;
    signIn("rep-1", "manager", "org-2");
    expect((await put()).status).toBe(200);
    expect(rows[0]).toMatchObject({ sharedWithOrg: false, organizationId: "org-2" });
  });

  it("checks optimistic concurrency and returns the current timestamp on conflict", async () => {
    const expectedUpdatedAt = T0.toISOString();
    const saved = await put({ scenario: { ...scenario, title: "First edit" }, expectedUpdatedAt });
    expect(saved.status).toBe(200);
    const version = (await saved.json()).item.updatedAt;
    expect(version).not.toBe(expectedUpdatedAt);
    const stale = await put({ scenario: { ...scenario, title: "Stale edit" }, expectedUpdatedAt });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", message: "This persona was updated elsewhere. Reload and try again.", updatedAt: version });
    expect(rows[0].title).toBe("First edit");
    expect((await put({ scenario, expectedUpdatedAt: version, sourceUrl: null })).status).toBe(200);
    expect(await (await remove()).json()).toEqual({ ok: true });
    expect((await get()).status).toBe(404);
  });

  it("rejects malformed, overlong, mismatched ids, invalid URLs and oversized bodies", async () => {
    for (const id of ["a", "bad/id", "a".repeat(81)]) expect((await post({ scenario: { ...scenario, id } })).status).toBe(400);
    expect((await put({ scenario: { ...scenario, id: "custom-other" } })).status).toBe(400);
    expect((await put({ scenario, expectedUpdatedAt: "yesterday" })).status).toBe(400);
    for (const sourceUrl of ["not-a-url", "ftp://example.test", `https://example.test/${"a".repeat(500)}`, "https://user:pass@example.test"]) {
      expect((await post({ scenario, sourceUrl })).status).toBe(400);
    }
    expect((await post({ scenario: { ...scenario, title: "a".repeat(121) } })).status).toBe(400);
    expect((await post({ scenario, extra: "a".repeat(MAX_BODY_BYTES) })).status).toBe(413);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("applies both scenario write rate limits before the database", async () => {
    expect(IP_LIMITS.scenarios()).toEqual({ limit: 60, windowMs: 3_600_000 });
    expect(USER_LIMITS.scenarios).toEqual({ limit: 60, windowMs: 3_600_000 });
    const blocked = () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
    mocks.ipLimitResponse.mockImplementation(blocked);
    for (const res of [await post(), await put(), await remove()]) expect(res.status).toBe(429);
    expect(mocks.userLimitResponse).not.toHaveBeenCalled();
    mocks.ipLimitResponse.mockReturnValue(null);
    mocks.userLimitResponse.mockImplementation(blocked);
    for (const res of [await post(), await put(), await remove()]) expect(res.status).toBe(429);
    expect(mocks.ipLimitResponse).toHaveBeenLastCalledWith(expect.any(Request), "scenarios");
    expect(mocks.userLimitResponse).toHaveBeenLastCalledWith("rep-1", "scenarios");
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

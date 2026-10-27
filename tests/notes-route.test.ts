import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database, the session check and the rate limiter are the only fakes; the route runs for real.
const mocks = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  prisma: {
    trainerSession: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", async () => {
  const { NextResponse } = await import("next/server");
  return { requireAuth: () => mocks.user ?? NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
});
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), rateLimit: mocks.rateLimit }));

import { GET, PUT } from "@/app/api/sessions/[sessionId]/notes/route";

type Row = {
  id: string; userId: string; organizationId: string;
  supervisorNotes: string | null; supervisorNotesBy: string | null; supervisorNotesAt: Date | null;
};
type Actor = { id: string; email: string; firstName: string | null; lastName: string | null; role: string; organizationId: string | null; isPlatformAdmin: boolean };

const T0 = new Date("2026-10-27T09:15:42.123Z");
let row: Row;
let actor: Actor | null;

const pick = (r: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k as keyof Row]])) : { ...r };

/** Signs in a user; the matching User row is what the route reads for role and org. */
const signIn = (role: string, organizationId: string | null, isPlatformAdmin = false, id = "m-1") => {
  mocks.user = { id, email: `${id}@example.test` };
  actor = { id, email: mocks.user.email, firstName: "Mia", lastName: "Chen", role, organizationId, isPlatformAdmin };
};

const put = (body: unknown, id = row.id) =>
  PUT(new NextRequest(`http://localhost/api/sessions/${id}/notes`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ sessionId: id }) });
const get = (id = row.id) => GET(new NextRequest(`http://localhost/api/sessions/${id}/notes`), { params: Promise.resolve({ sessionId: id }) });
/** What NoteEditor stores as loadedAt: the GET body's supervisorNotesAt after JSON. */
const loadedAt = async () => ((await (await get()).json()) as { supervisorNotesAt: string | null }).supervisorNotesAt;

beforeEach(() => {
  row = { id: "s-1", userId: "rep-1", organizationId: "org-1", supervisorNotes: "Slow down on price.", supervisorNotesBy: "Ana Ruiz", supervisorNotesAt: T0 };
  signIn("manager", "org-1");
  for (const fn of [mocks.prisma.trainerSession.findUnique, mocks.prisma.trainerSession.update, mocks.prisma.trainerSession.updateMany, mocks.prisma.user.findUnique, mocks.prisma.auditEvent.create, mocks.prisma.$transaction, mocks.rateLimit]) fn.mockReset();

  mocks.rateLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterMs: 0 });
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (actor && where.id === actor.id ? actor : null));
  mocks.prisma.trainerSession.findUnique.mockImplementation(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) =>
    where.id === row.id ? pick(row, select) : null);
  mocks.prisma.trainerSession.update.mockImplementation(async ({ where, data, select }: { where: { id: string }; data: Partial<Row>; select?: Record<string, boolean> }) => {
    if (where.id !== row.id) throw new Error("Record to update not found.");
    Object.assign(row, data);
    return pick(row, select);
  });
  // Same rules as Postgres: undefined is no filter, null is IS NULL, a Date is an exact match. Mutates synchronously,
  // so a findUnique queued after it in $transaction sees the write, as it does inside the real transaction.
  mocks.prisma.trainerSession.updateMany.mockImplementation(async ({ where, data }: { where: { id: string; supervisorNotesAt?: Date | null }; data: Partial<Row> }) => {
    const want = where.supervisorNotesAt;
    const atMatches = want === undefined || (want === null ? row.supervisorNotesAt === null : row.supervisorNotesAt?.getTime() === want.getTime());
    if (where.id !== row.id || !atMatches) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  mocks.prisma.auditEvent.create.mockImplementation(async (args: unknown) => args);
  mocks.prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe("PUT /api/sessions/[sessionId]/notes with expectedNotesAt", () => {
  it("saves when the note is unchanged since the editor loaded it", async () => {
    const at = await loadedAt();
    expect(at).toBe(T0.toISOString()); // millisecond ISO string, so it round-trips into an exact match

    const res = await put({ note: "  Ask about budget before quoting.  ", expectedNotesAt: at });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: row.id, supervisorNotes: "Ask about budget before quoting.", supervisorNotesBy: "Mia Chen" });
    expect(Object.keys(body).sort()).toEqual(["id", "supervisorNotes", "supervisorNotesAt", "supervisorNotesBy"]);
    expect(body.supervisorNotesAt).not.toBe(at);

    const { where } = mocks.prisma.trainerSession.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: row.id, supervisorNotesAt: T0 });
    expect(mocks.prisma.trainerSession.update).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({
      userId: "m-1", action: "session.supervisor_notes_updated", resource: row.id, metadata: { length: 32, trainee: "rep-1" },
    });
  });

  it("returns 409 for a stale timestamp and changes nothing", async () => {
    const before = { ...row };
    const res = await put({ note: "Overwrite", expectedNotesAt: new Date(T0.getTime() - 1).toISOString() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", message: "Someone changed this note after you opened it. Open it again to see the latest version." });
    expect(row).toEqual(before);
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("lets only the first of two editors who loaded the same version save", async () => {
    const at = await loadedAt();
    signIn("owner", "org-1", false, "o-1");
    expect((await put({ note: "First", expectedNotesAt: at })).status).toBe(200);
    signIn("manager", "org-1");
    expect((await put({ note: "Second", expectedNotesAt: at })).status).toBe(409);
    expect(row.supervisorNotes).toBe("First");
  });

  it("matches null only against an empty note", async () => {
    expect((await put({ note: "New note", expectedNotesAt: null })).status).toBe(409);
    expect(row.supervisorNotes).toBe("Slow down on price.");

    // Clearing with the right timestamp stores null, which a later null then matches.
    const cleared = await put({ note: "   ", expectedNotesAt: T0.toISOString() });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ supervisorNotes: null, supervisorNotesBy: null, supervisorNotesAt: null });
    expect(await loadedAt()).toBeNull();

    expect((await put({ note: "New note", expectedNotesAt: null })).status).toBe(200);
    expect(row.supervisorNotes).toBe("New note");
    expect(mocks.prisma.trainerSession.updateMany.mock.calls.at(-1)?.[0].where).toEqual({ id: row.id, supervisorNotesAt: null });
  });

  it("overwrites as before when expectedNotesAt is missing", async () => {
    row.supervisorNotesAt = new Date(T0.getTime() + 60_000); // someone else saved since; an old client can't tell
    const res = await put({ note: "Old client" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: row.id, supervisorNotes: "Old client", supervisorNotesBy: "Mia Chen" });
    expect(mocks.prisma.trainerSession.update.mock.calls[0][0].where).toEqual({ id: row.id });
    expect(mocks.prisma.trainerSession.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledOnce();
  });

  it("rejects an expectedNotesAt that isn't a UTC ISO timestamp", async () => {
    for (const expectedNotesAt of ["yesterday", "2026-10-27T10:15:42.123+01:00", 1_793_000_000_000]) {
      const res = await put({ note: "x", expectedNotesAt });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request body" });
    }
    expect(mocks.prisma.trainerSession.updateMany).not.toHaveBeenCalled();
  });

  it("gives people who can't write the same response as before, never 409", async () => {
    const variants = [{ note: "x" }, { note: "x", expectedNotesAt: T0.toISOString() }, { note: "x", expectedNotesAt: null }, { note: "x", expectedNotesAt: "2020-01-01T00:00:00.000Z" }];
    const responses = async (id?: string) => {
      const out: { status: number; body: unknown }[] = [];
      for (const v of variants) {
        const res = await put(v, id);
        out.push({ status: res.status, body: await res.json() });
      }
      return out;
    };
    const forbidden = { status: 403, body: { error: "Only managers or owners of this organization can post supervisor notes." } };

    signIn("trainee", "org-1", false, "rep-1"); // the rep who owns the session can read the note but not write it
    expect(await responses()).toEqual(variants.map(() => forbidden));
    signIn("manager", "org-2");
    expect(await responses()).toEqual(variants.map(() => forbidden));
    signIn("manager", "org-1");
    expect(await responses("missing")).toEqual(variants.map(() => ({ status: 404, body: { error: "Not found" } })));
    signIn("manager", "org-1");
    actor = null; // a token for a user who no longer exists
    expect(await responses()).toEqual(variants.map(() => ({ status: 401, body: { error: "Unknown user" } })));
    mocks.user = null;
    expect(await responses()).toEqual(variants.map(() => ({ status: 401, body: { error: "Authentication required" } })));

    expect(mocks.prisma.trainerSession.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.trainerSession.update).not.toHaveBeenCalled();
    expect(mocks.prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("lets a platform admin from another org save with a matching timestamp", async () => {
    signIn("trainee", "org-9", true, "admin-1");
    expect((await put({ note: "Admin note", expectedNotesAt: T0.toISOString() })).status).toBe(200);
  });

  it("checks the per-user rate limit before anything else", async () => {
    mocks.rateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 30_000 });
    const res = await put({ note: "x", expectedNotesAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Rate limit exceeded" });
    expect(mocks.rateLimit).toHaveBeenCalledWith({ key: "notes:m-1", limit: 30, windowMs: 60_000 });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.trainerSession.findUnique).not.toHaveBeenCalled();
  });
});

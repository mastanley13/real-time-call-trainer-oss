import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Team overview and assignments read role and organization from the User row, not the session
 * object. A trainee, a manager of another org, or a stale token that still says "manager" must
 * not see or change another team's calls. The database and the session check are the only fakes;
 * both routes run for real.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "m-1", email: "m-1@example.test", role: "manager" as string },
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    trainerSession: { findMany: vi.fn(), groupBy: vi.fn() },
    trainingAssignment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET as overview } from "@/app/api/team/overview/route";
import { DELETE as archiveAssignment, GET as listAssignments, POST as createAssignment } from "@/app/api/team/assignments/route";
import { LIBRARY } from "@/lib/personas";
import type { TeamOverview } from "@/lib/team";

const LIBRARY_ID = LIBRARY[0].id;
const LIBRARY_TITLE = LIBRARY[0].title;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const evaluation = (score: number) => ({
  method: "llm",
  graderVersion: "llm-v2",
  overallScore: score,
  criteria: [{ name: "Discovery", score }],
});

type Actor = {
  id: string;
  role: string;
  isPlatformAdmin: boolean;
  organizationId: string | null;
  firstName: string;
  lastName: string;
  email: string;
};
type SessionRow = {
  id: string;
  userId: string;
  organizationId: string;
  scenarioId: string;
  scenarioTitle: string | null;
  overallScore: number;
  goalAchieved: boolean;
  evaluation: ReturnType<typeof evaluation>;
  createdAt: Date;
  supervisorNotes: string | null;
};
type AssignmentRow = {
  id: string;
  organizationId: string;
  assignedById: string;
  assigneeId: string | null;
  scenarioId: string;
  scenarioTitle: string;
  note: string | null;
  dueAt: Date | null;
  createdAt: Date;
  archivedAt: Date | null;
};

let n = 0;
const actors = new Map<string, Actor>();
const members: Actor[] = [];
const orgs = new Map<string, { id: string; name: string; sessionRetentionDays: number | null }>();
const sessions: SessionRow[] = [];
const assignments: AssignmentRow[] = [];

const OVERVIEW_FORBIDDEN = {
  error: "forbidden",
  message: "Team view is for managers and owners. Ask your manager if you need access.",
};
const ASSIGN_FORBIDDEN = {
  error: "forbidden",
  message: "Only managers and owners can assign personas.",
};

function signIn(partial: Partial<Actor> & Pick<Actor, "role">) {
  const id = partial.id ?? `authz-${++n}`;
  const row: Actor = {
    id,
    email: `${id}@example.test`,
    firstName: "Mia",
    lastName: "Chen",
    isPlatformAdmin: false,
    organizationId: "o-1",
    ...partial,
  };
  actors.set(id, row);
  mocks.user = { id: row.id, email: row.email, role: "owner" };
  return row;
}

function getOverview(days?: string) {
  const q = days ? `?days=${days}` : "";
  return overview(new NextRequest(`http://localhost/api/team/overview${q}`));
}

function getAssignments(scope?: string) {
  const q = scope ? `?scope=${scope}` : "";
  return listAssignments(new NextRequest(`http://localhost/api/team/assignments${q}`));
}

function postAssignment(body: unknown) {
  return createAssignment(new NextRequest("http://localhost/api/team/assignments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function deleteAssignment(id: string) {
  return archiveAssignment(new NextRequest(`http://localhost/api/team/assignments?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("DEMO_MODE", "");
  n = 0;
  actors.clear();
  members.length = 0;
  sessions.length = 0;
  assignments.length = 0;
  orgs.clear();
  orgs.set("o-1", { id: "o-1", name: "Harbor Point", sessionRetentionDays: null });
  orgs.set("o-2", { id: "o-2", name: "Other Team", sessionRetentionDays: null });
  members.push(
    { id: "mgr-1", role: "manager", isPlatformAdmin: false, organizationId: "o-1", firstName: "Mia", lastName: "Chen", email: "mgr-1@example.test" },
    { id: "rep-1", role: "trainee", isPlatformAdmin: false, organizationId: "o-1", firstName: "Ravi", lastName: "Shah", email: "rep-1@example.test" },
    { id: "mgr-2", role: "manager", isPlatformAdmin: false, organizationId: "o-2", firstName: "Ana", lastName: "Ruiz", email: "mgr-2@example.test" },
    { id: "rep-2", role: "trainee", isPlatformAdmin: false, organizationId: "o-2", firstName: "Ben", lastName: "Ode", email: "rep-2@example.test" },
  );
  for (const m of members) actors.set(m.id, m);
  sessions.push(
    {
      id: "s-ours", userId: "rep-1", organizationId: "o-1", scenarioId: LIBRARY_ID, scenarioTitle: null,
      overallScore: 50, goalAchieved: false, evaluation: evaluation(50), createdAt: ago(2), supervisorNotes: "Ask about budget.",
    },
    {
      id: "s-theirs", userId: "rep-2", organizationId: "o-2", scenarioId: LIBRARY_ID, scenarioTitle: null,
      overallScore: 100, goalAchieved: true, evaluation: evaluation(100), createdAt: ago(1), supervisorNotes: "Other team's private note.",
    },
  );
  assignments.push(
    {
      id: "a-ours", organizationId: "o-1", assignedById: "mgr-1", assigneeId: "rep-1",
      scenarioId: LIBRARY_ID, scenarioTitle: LIBRARY_TITLE, note: null, dueAt: null, createdAt: ago(5), archivedAt: null,
    },
    {
      id: "a-theirs", organizationId: "o-2", assignedById: "mgr-2", assigneeId: "rep-2",
      scenarioId: LIBRARY_ID, scenarioTitle: LIBRARY_TITLE, note: "Do not leak this.", dueAt: null, createdAt: ago(4), archivedAt: null,
    },
  );

  for (const group of Object.values(mocks.prisma)) for (const fn of Object.values(group)) fn.mockReset();

  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => actors.get(where.id) ?? null);
  mocks.prisma.user.findMany.mockImplementation(async ({ where }: { where: { organizationId?: string } }) =>
    members.filter((m) => !where.organizationId || m.organizationId === where.organizationId));
  mocks.prisma.user.findFirst.mockImplementation(async ({ where }: { where: { id?: string; organizationId?: string } }) =>
    members.find((m) => (!where.id || m.id === where.id) && (!where.organizationId || m.organizationId === where.organizationId)) ?? null);
  mocks.prisma.organization.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    (where.id ? orgs.get(where.id) : null) ?? null);
  mocks.prisma.trainerSession.findMany.mockImplementation(async ({ where }: { where: { organizationId?: string; createdAt?: { gte?: Date; lt?: Date } } }) =>
    sessions.filter((s) => {
      if (where.organizationId && s.organizationId !== where.organizationId) return false;
      if (where.createdAt?.gte && s.createdAt < where.createdAt.gte) return false;
      if (where.createdAt?.lt && s.createdAt >= where.createdAt.lt) return false;
      return true;
    }));
  mocks.prisma.trainerSession.groupBy.mockImplementation(async ({ where }: { where: { organizationId?: string } }) => {
    const ids = [...new Set(sessions.filter((s) => !where.organizationId || s.organizationId === where.organizationId).map((s) => s.userId))];
    return ids.map((userId) => ({ userId, _max: { createdAt: ago(1) } }));
  });
  mocks.prisma.trainingAssignment.findMany.mockImplementation(async ({ where }: { where: { organizationId?: string; archivedAt?: Date | null; OR?: { assigneeId: string | null }[] } }) =>
    assignments.filter((a) => {
      if (where.organizationId && a.organizationId !== where.organizationId) return false;
      if (where.archivedAt === null && a.archivedAt !== null) return false;
      if (where.OR) return where.OR.some((clause) => a.assigneeId === clause.assigneeId);
      return true;
    }));
  mocks.prisma.trainingAssignment.findFirst.mockImplementation(async ({ where }: { where: { id?: string; organizationId?: string; archivedAt?: Date | null } }) =>
    assignments.find((a) =>
      (!where.id || a.id === where.id)
      && (!where.organizationId || a.organizationId === where.organizationId)
      && (where.archivedAt === undefined || a.archivedAt === where.archivedAt),
    ) ?? null);
  mocks.prisma.trainingAssignment.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row: AssignmentRow = {
      id: `a-${++n}`,
      organizationId: String(data.organizationId),
      assignedById: String(data.assignedById),
      assigneeId: (data.assigneeId as string | null) ?? null,
      scenarioId: String(data.scenarioId),
      scenarioTitle: String(data.scenarioTitle),
      note: (data.note as string | null) ?? null,
      dueAt: (data.dueAt as Date | null) ?? null,
      createdAt: new Date(NOW),
      archivedAt: null,
    };
    assignments.push(row);
    return row;
  });
  mocks.prisma.trainingAssignment.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<AssignmentRow> }) => {
    const row = assignments.find((a) => a.id === where.id);
    if (!row) throw new Error("Record to update not found.");
    Object.assign(row, data);
    return row;
  });
  mocks.prisma.auditEvent.create.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/team/overview authorization", () => {
  it("returns 403 for a trainee and does not read sessions", async () => {
    signIn({ id: "rep-1", role: "trainee", organizationId: "o-1" });
    const res = await getOverview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(OVERVIEW_FORBIDDEN);
    expect(mocks.prisma.trainerSession.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.trainerSession.groupBy).not.toHaveBeenCalled();
  });

  it("uses the database role, so a session that still claims owner is 403 when the row is trainee", async () => {
    signIn({ id: "rep-1", role: "trainee", organizationId: "o-1" });
    expect(mocks.user.role).toBe("owner");
    const res = await getOverview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(OVERVIEW_FORBIDDEN);
    expect(mocks.prisma.trainerSession.findMany).not.toHaveBeenCalled();
  });

  it("scopes a manager to their own organization, even when another org has higher scores", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await getOverview("30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamOverview;
    expect(body.org).toMatchObject({ id: "o-1", name: "Harbor Point" });
    expect(body.kpis.sessions).toBe(1);
    expect(body.kpis.avgScore).toBe(50);
    expect(body.roster.map((r) => r.id)).toEqual(["rep-1"]);
    expect(body.members.map((m) => m.id).sort()).toEqual(["mgr-1", "rep-1"]);
    expect(JSON.stringify(body)).not.toContain("s-theirs");
    expect(JSON.stringify(body)).not.toContain("Other team's private note.");
    expect(JSON.stringify(body)).not.toContain("rep-2");
    for (const [args] of mocks.prisma.trainerSession.findMany.mock.calls) {
      expect(args.where.organizationId).toBe("o-1");
    }
    expect(mocks.prisma.trainerSession.groupBy.mock.calls[0][0].where.organizationId).toBe("o-1");
  });

  it("lets an owner in, and a platform admin whose stored role is trainee in, still scoped to their org", async () => {
    signIn({ id: "own-1", role: "owner", organizationId: "o-1", firstName: "Ola", lastName: "Reyes" });
    members.push(actors.get("own-1")!);
    expect((await getOverview()).status).toBe(200);

    signIn({ id: "admin-1", role: "trainee", isPlatformAdmin: true, organizationId: "o-1", firstName: "Pat", lastName: "Admin" });
    members.push(actors.get("admin-1")!);
    const res = await getOverview();
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamOverview;
    expect(body.kpis.sessions).toBe(1);
    expect(JSON.stringify(body)).not.toContain("s-theirs");
  });

  it("returns 401 when the session user is gone, and 404 when they have no organization", async () => {
    signIn({ id: "ghost", role: "manager", organizationId: "o-1" });
    actors.delete("ghost");
    const missing = await getOverview();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unknown user" });

    signIn({ id: "solo", role: "owner", organizationId: null });
    const noOrg = await getOverview();
    expect(noOrg.status).toBe(404);
    expect((await noOrg.json()).error).toBe("no_organization");
    expect(mocks.prisma.trainerSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a window that is not 7, 30 or 90 before touching the database", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await getOverview("14");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/team/assignments authorization", () => {
  it("keeps a trainee on their own list even when they ask for scope=team", async () => {
    signIn({ id: "rep-1", role: "trainee", organizationId: "o-1" });
    const res = await getAssignments("team");
    expect(res.status).toBe(200);
    const body = await res.json() as { scope: string; assignments: { id: string }[] };
    expect(body.scope).toBe("mine");
    expect(body.assignments.map((a) => a.id)).toEqual(["a-ours"]);
    expect(JSON.stringify(body)).not.toContain("a-theirs");
    expect(JSON.stringify(body)).not.toContain("Do not leak this.");
    expect(mocks.prisma.trainingAssignment.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: "o-1",
      archivedAt: null,
      OR: [{ assigneeId: "rep-1" }, { assigneeId: null }],
    });
  });

  it("lets a manager read the whole org list, still without the other org's assignment", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await getAssignments("team");
    expect(res.status).toBe(200);
    const body = await res.json() as { scope: string; assignments: { id: string }[] };
    expect(body.scope).toBe("team");
    expect(body.assignments.map((a) => a.id)).toEqual(["a-ours"]);
    expect(mocks.prisma.trainingAssignment.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(mocks.prisma.trainingAssignment.findMany.mock.calls[0][0].where.organizationId).toBe("o-1");
  });
});

describe("POST /api/team/assignments authorization", () => {
  const body = { scenarioId: LIBRARY_ID, scenarioTitle: LIBRARY_TITLE, assigneeId: "rep-1" };

  it("returns 403 for a trainee and does not create a row", async () => {
    signIn({ id: "rep-1", role: "trainee", organizationId: "o-1" });
    const res = await postAssignment(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ASSIGN_FORBIDDEN);
    expect(mocks.prisma.trainingAssignment.create).not.toHaveBeenCalled();
  });

  it("refuses an assignee who is not in the actor's organization", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await postAssignment({ ...body, assigneeId: "rep-2" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_assignee" });
    expect(mocks.prisma.trainingAssignment.create).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: "rep-2", organizationId: "o-1" },
      select: { id: true },
    });
  });

  it("stores the actor's organization id, not a client-supplied one", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await postAssignment({ ...body, organizationId: "o-2" });
    expect(res.status).toBe(201);
    expect(mocks.prisma.trainingAssignment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: "o-1", assignedById: "mgr-1", assigneeId: "rep-1" }),
    }));
    expect(mocks.prisma.trainingAssignment.create.mock.calls[0][0].data.organizationId).not.toBe("o-2");
  });
});

describe("DELETE /api/team/assignments authorization", () => {
  it("returns 403 for a trainee and does not archive", async () => {
    signIn({ id: "rep-1", role: "trainee", organizationId: "o-1" });
    const res = await deleteAssignment("a-ours");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(OVERVIEW_FORBIDDEN);
    expect(mocks.prisma.trainingAssignment.update).not.toHaveBeenCalled();
  });

  it("returns 404 for another org's assignment, without revealing it exists", async () => {
    signIn({ id: "mgr-1", role: "manager", organizationId: "o-1" });
    const res = await deleteAssignment("a-theirs");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Not found" });
    expect(mocks.prisma.trainingAssignment.update).not.toHaveBeenCalled();
    expect(assignments.find((a) => a.id === "a-theirs")?.archivedAt).toBeNull();
    expect(mocks.prisma.trainingAssignment.findFirst).toHaveBeenCalledWith({
      where: { id: "a-theirs", organizationId: "o-1", archivedAt: null },
      select: { id: true },
    });
  });
});

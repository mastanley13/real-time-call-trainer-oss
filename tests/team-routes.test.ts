import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the session check are the only fakes; both team routes run for real.
const mocks = vi.hoisted(() => ({
  user: { id: "m-1", email: "m-1@example.test" },
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    organization: { findUnique: vi.fn() },
    trainerSession: { findMany: vi.fn(), groupBy: vi.fn() },
    trainingAssignment: { findMany: vi.fn(), create: vi.fn() },
    auditEvent: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET as overview } from "@/app/api/team/overview/route";
import { POST as assign } from "@/app/api/team/assignments/route";
import { LIBRARY } from "@/lib/personas";
import type { TeamOverview } from "@/lib/team";

const LIBRARY_ID = LIBRARY[0].id;
const CUSTOM_ID = "custom-my-easy-persona";
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const evaluation = (score: number, criteria: { name: string; score: number }[]) => ({ method: "llm", graderVersion: "llm-v2", overallScore: score, criteria });

const savedEnv = { DATABASE_URL: process.env.DATABASE_URL, DEMO_MODE: process.env.DEMO_MODE };
beforeEach(() => {
  // Database mode, so the routes read the (mocked) database instead of the sample team.
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  delete process.env.DEMO_MODE;
  for (const group of Object.values(mocks.prisma)) for (const fn of Object.values(group)) fn.mockReset();
  mocks.prisma.user.findUnique.mockResolvedValue({ id: "m-1", role: "manager", isPlatformAdmin: false, organizationId: "o-1", firstName: "Mia", lastName: "Chen", email: "m-1@example.test" });
  mocks.prisma.user.findMany.mockResolvedValue([
    { id: "m-1", firstName: "Mia", lastName: "Chen", email: "m-1@example.test", role: "manager" },
    { id: "r-1", firstName: "Ravi", lastName: "Shah", email: "r-1@example.test", role: "trainee" },
  ]);
  mocks.prisma.organization.findUnique.mockResolvedValue({ id: "o-1", name: "Harbor Point", sessionRetentionDays: null });
  mocks.prisma.trainingAssignment.findMany.mockResolvedValue([]);
  mocks.prisma.trainerSession.groupBy.mockResolvedValue([{ userId: "r-1", _max: { createdAt: ago(1) } }]);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("team overview", () => {
  it("counts a custom-persona call as practice but keeps its self-chosen rubric out of team scores", async () => {
    const rows = [
      { id: "s-lib", userId: "r-1", scenarioId: LIBRARY_ID, scenarioTitle: null, overallScore: 50, goalAchieved: false, evaluation: evaluation(50, [{ name: "Discovery", score: 50 }]), createdAt: ago(2), supervisorNotes: null },
      // A rep could write a custom persona whose rubric is trivially easy and get a genuine, sealed 100 on it.
      { id: "s-own", userId: "r-1", scenarioId: CUSTOM_ID, scenarioTitle: "My easy persona", overallScore: 100, goalAchieved: true, evaluation: evaluation(100, [{ name: "Said hello", score: 100 }]), createdAt: ago(1), supervisorNotes: null },
    ];
    // Window query first, then the older history query (it has an upper bound).
    mocks.prisma.trainerSession.findMany.mockImplementation(({ where }: { where: { createdAt: { lt?: Date } } }) => Promise.resolve(where.createdAt.lt ? [] : rows));

    const res = await overview(new NextRequest("http://localhost/api/team/overview?days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as TeamOverview;
    const rep = body.roster.find((r) => r.id === "r-1")!;

    expect(body.kpis.sessions).toBe(2);
    expect(rep.sessions).toBe(2);
    expect(body.kpis.avgScore).toBe(50);
    expect(rep.avgScore).toBe(50);
    expect(body.matrix.criteria).not.toContain("Said hello");
    expect(body.queue.map((q) => q.sessionId)).not.toContain("s-own");
  });
});

describe("team assignments", () => {
  const post = (scenarioId: string) =>
    assign(new NextRequest("http://localhost/api/team/assignments", { method: "POST", body: JSON.stringify({ scenarioId, scenarioTitle: "Some persona", assigneeId: "r-1" }), headers: { "Content-Type": "application/json" } }));

  it("refuses a persona that isn't in the library", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ id: "r-1" });
    const res = await post(CUSTOM_ID);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_persona" });
    expect(mocks.prisma.trainingAssignment.create).not.toHaveBeenCalled();
  });

  it("assigns a library persona", async () => {
    mocks.prisma.user.findFirst.mockResolvedValue({ id: "r-1" });
    mocks.prisma.trainingAssignment.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "a-1", createdAt: new Date(NOW), dueAt: null, ...data }));
    const res = await post(LIBRARY_ID);
    expect(res.status).toBe(201);
    expect(mocks.prisma.trainingAssignment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ scenarioId: LIBRARY_ID }) }));
  });
});

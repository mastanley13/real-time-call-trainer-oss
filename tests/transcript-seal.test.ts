import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  user: { id: "u-rep", email: "rep@example.test" },
  saved: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  prisma: {
    user: { findUnique: vi.fn() },
    auditEvent: { create: vi.fn() },
    trainerSession: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));

import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { POST as evaluateCall } from "@/app/api/evaluate-call/route";
import { sealEvaluation } from "@/lib/gradeSeal";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const KEY = "ci-only-not-a-secret-0123456789abcdef";
const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const transcript = [
  { role: "assistant" as const, text: "Hi, my water heater died this morning." },
  { role: "user" as const, text: "Sorry to hear that. How old is the unit, and is the leak from the tank or a pipe?" },
];
const evaluation = {
  method: "heuristic" as const,
  overallScore: 62,
  grade: "C" as const,
  criteria: [{ id: "discovery", score: 55 }],
  goalAchievement: { achieved: false },
  evaluatedAt: "2026-10-27T10:00:00.000Z",
};

let seq = 0;
const ip = () => `10.4.${Math.floor(++seq / 250)}.${seq % 250}`;
const signIn = (id = `u-${++seq}`) => (mocks.user = { id, email: `${id}@example.test` });

function save(body: unknown, from = ip()) {
  return saveTranscript(new NextRequest("http://localhost/api/transcripts", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  }));
}

function gradeBody(patch: Record<string, unknown> = {}) {
  return {
    sessionId: `text-${++seq}`,
    transcript,
    durationSeconds: 90,
    scenario: { id: scenario.id, title: scenario.title, industry: scenario.industry, difficulty: scenario.difficulty },
    evaluation,
    ...patch,
  };
}

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
  mocks.saved = [];
  mocks.audits = [];
  for (const group of Object.values(mocks.prisma)) for (const fn of Object.values(group)) fn.mockReset();
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (
    where.id === mocks.user.id ? { id: mocks.user.id, organizationId: "org-1" } : null
  ));
  mocks.prisma.trainerSession.findUnique.mockResolvedValue(null);
  mocks.prisma.trainerSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: typeof data.id === "string" ? data.id : `s-${++seq}`, ...data };
    mocks.saved.push(row);
    return row;
  });
  mocks.prisma.auditEvent.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.audits.push(data);
    return data;
  });
  signIn();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("POST /api/transcripts stores a score only with a valid grade seal", () => {
  it("keeps a server-sealed grade and reports graded true", async () => {
    const seal = sealEvaluation({ userId: mocks.user.id, scenarioId: scenario.id, transcript, evaluation }, KEY);
    const res = await save(gradeBody({ seal }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ graded: true });
    expect(mocks.saved[0]).toMatchObject({ overallScore: 62, grade: "C", goalAchieved: false, evaluation });
    expect(mocks.audits[0]).toMatchObject({ action: "session.saved", metadata: { overallScore: 62 } });
    expect((mocks.audits[0].metadata as { gradeRejected?: boolean }).gradeRejected).toBeUndefined();
  });

  it("saves ungraded when the client edits the score after sealing", async () => {
    const seal = sealEvaluation({ userId: mocks.user.id, scenarioId: scenario.id, transcript, evaluation }, KEY);
    const res = await save(gradeBody({ seal, evaluation: { ...evaluation, overallScore: 100, grade: "A" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ graded: false });
    expect(mocks.saved[0]).toMatchObject({ overallScore: null, grade: null, goalAchieved: null, evaluation: Prisma.JsonNull });
    expect(mocks.audits[0]).toMatchObject({ action: "session.saved", metadata: { overallScore: null, gradeRejected: true } });
  });

  it("saves ungraded without a seal, with a forged hex, or with another user's seal", async () => {
    const own = sealEvaluation({ userId: mocks.user.id, scenarioId: scenario.id, transcript, evaluation }, KEY);
    const other = sealEvaluation({ userId: "someone-else", scenarioId: scenario.id, transcript, evaluation }, KEY);
    for (const seal of [undefined, "0".repeat(64), other]) {
      mocks.saved = [];
      mocks.audits = [];
      signIn();
      const res = await save(gradeBody({ seal, ...(seal === undefined ? { evaluation } : {}) }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ graded: false });
      expect(mocks.saved[0].overallScore).toBeNull();
      expect(mocks.saved[0].evaluation).toBe(Prisma.JsonNull);
      expect(mocks.audits[0]).toMatchObject({ metadata: { gradeRejected: true } });
    }
    expect(own).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a replayed seal on a different transcript", async () => {
    const seal = sealEvaluation({ userId: mocks.user.id, scenarioId: scenario.id, transcript, evaluation }, KEY);
    const otherTurns = [...transcript, { role: "assistant" as const, text: "I already have a plumber." }];
    const res = await save(gradeBody({ seal, transcript: otherTurns }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ graded: false });
    expect(mocks.saved[0].overallScore).toBeNull();
  });
});

describe("the evaluate-call seal is what transcripts accepts", () => {
  it("a heuristic grade plus its seal stores as graded, and a bumped score with that seal does not", async () => {
    const from = ip();
    const evalRes = await evaluateCall(new NextRequest("http://localhost/api/evaluate-call", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify({ scenario, transcript }),
    }));
    expect(evalRes.status).toBe(200);
    const graded = await evalRes.json() as { seal?: string; overallScore: number; grade: string; goalAchievement: { achieved: boolean } };
    expect(graded.seal).toMatch(/^[0-9a-f]{64}$/);
    const { seal, ...evaluationOut } = graded;

    const ok = await save(gradeBody({ evaluation: evaluationOut, seal }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ graded: true });
    expect(mocks.saved[0]).toMatchObject({ overallScore: Math.round(evaluationOut.overallScore), grade: evaluationOut.grade });

    mocks.saved = [];
    mocks.audits = [];
    const forged = await save(gradeBody({ evaluation: { ...evaluationOut, overallScore: 100, grade: "A" }, seal }));
    expect(forged.status).toBe(200);
    expect(await forged.json()).toMatchObject({ graded: false });
    expect(mocks.saved[0].overallScore).toBeNull();
  });
});

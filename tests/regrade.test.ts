import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

// Same fakes as grader.test.ts: the model call, the database and the session check. Capping and grading run for real.
const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  user: { id: "u-0", email: "rep@example.test" } as { id: string; email: string },
  prisma: {
    trainerSession: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/llm")>()), chat: mocks.chat }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: (u: { id: string }) => u.id === "demo-user" }));

import type { Evaluation } from "@/lib/grader-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { GRADE_MAX_CHARS, GRADE_MAX_TURNS, canRegrade, gradable, gradedNote, isAiGrade, wasCapped } from "@/lib/gradable";
import { PATCH } from "@/app/api/transcripts/[id]/route";
import { POST as evaluate } from "@/app/api/evaluate-call/route";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const NOT_ALLOWED = "This call already has an AI grade. Ask your manager if you think it is wrong.";
const AI_GRADE = { method: "llm", graderVersion: "llm-v2", model: "gpt-test-mini", overallScore: 64 };
const RULES_GRADE = { method: "heuristic", graderVersion: "heuristic-v2", overallScore: 41 };

const FILLER = "We went over the leak, the age of the unit and the visit fee again. ";
/** `n` turns of exactly `len` characters, the rep first. Each starts with its own number so a cut is easy to spot. */
const longCall = (n: number, len: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    text: `Turn ${i + 1}. ${FILLER.repeat(Math.ceil(len / FILLER.length))}`.slice(0, len),
  }));

const llmReply = () =>
  JSON.stringify({
    summary: "You kept the caller talking.",
    criteria: scenario.rubric.map((c) => ({ id: c.id, score: 72, rationale: "You made a solid attempt.", evidence: [] })),
    strengths: ["You stayed calm."],
    improvements: ["Offer a time slot."],
    goalStatus: "partial",
    goalExplanation: "You made progress but booked nothing.",
  });
const promptOf = (call = 0) => mocks.chat.mock.calls[call][0][1].content as string;

const ENV_KEYS = ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "DATABASE_URL", "DEMO_MODE", "JWT_SECRET", "RATE_LIMIT_GRADING_MAX"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let n = 0;
/** Signs in a fresh user per call so the per-user limits never leak between tests. */
const signIn = (id = `u-${++n}`) => (mocks.user = { id, email: `${id}@example.test` });

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RATE_LIMIT_GRADING_MAX = "1000";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gpt-test-mini";
  mocks.chat.mockReset();
  mocks.chat.mockResolvedValue(llmReply());
});
afterEach(() => {
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
});

describe("gradable", () => {
  it("keeps the opening turns within both limits, and never fewer than one", () => {
    expect(gradable(longCall(GRADE_MAX_TURNS + 5, 20))).toHaveLength(GRADE_MAX_TURNS);
    expect(gradable(longCall(300, 500))).toHaveLength(GRADE_MAX_CHARS / 500);
    expect(gradable([{ role: "user", text: "x".repeat(GRADE_MAX_CHARS + 1) }])).toHaveLength(1);
    const fits = longCall(300, 50);
    expect(gradable(fits)).toEqual(fits);
  });

  it("adds the cap line only when turns were dropped", () => {
    expect(gradedNote(undefined, 300, 300)).toBeUndefined();
    expect(gradedNote("Grader note.", 300, 300)).toBe("Grader note.");
    expect(gradedNote("Grader note.", 240, 300)).toBe("Grader note. This call was longer than the grader reads, so only the first 240 of 300 turns were graded.");
  });

  it("tells a capped grade's note from any other, so the debrief doesn't say it read the full transcript", () => {
    expect(wasCapped(gradedNote(undefined, 240, 300))).toBe(true);
    expect(wasCapped(gradedNote("This is an automatic estimate.", 133, 150))).toBe(true);
    for (const note of [gradedNote(undefined, 300, 300), gradedNote("Grader note.", 300, 300), "", undefined]) expect(wasCapped(note)).toBe(false);
  });

  it("tells AI grades from rules-based ones, and lets only managers re-grade an AI grade", () => {
    expect(isAiGrade(AI_GRADE)).toBe(true);
    expect(isAiGrade({ method: "llm" })).toBe(true); // older AI grades have no model recorded
    for (const ev of [RULES_GRADE, { overallScore: 50 }, null, undefined, "llm"]) expect(isAiGrade(ev)).toBe(false);

    expect(canRegrade({ managesOrg: false, ownsSession: true }, AI_GRADE)).toBe(false);
    expect(canRegrade({ managesOrg: false, ownsSession: true }, RULES_GRADE)).toBe(true);
    expect(canRegrade({ managesOrg: false, ownsSession: true }, null)).toBe(true);
    expect(canRegrade({ managesOrg: true, ownsSession: false }, AI_GRADE)).toBe(true);
    expect(canRegrade({ managesOrg: false, ownsSession: false }, RULES_GRADE)).toBe(false);
  });
});

describe("PATCH /api/transcripts/[id] (server re-grade)", () => {
  type Row = { id: string; userId: string; organizationId: string; scenarioId: string; transcript: unknown; evaluation: unknown; overallScore: number | null; updatedAt: Date };
  let row: Row;
  let trainee: string;
  /** Audit rows the transaction actually wrote. */
  let audits: { metadata: Record<string, unknown> }[];

  const patch = (body: unknown = {}, id = row.id) =>
    PATCH(new NextRequest(`http://localhost/api/transcripts/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", "user-agent": "vitest" } }), { params: Promise.resolve({ id }) });
  /** Signs in as a new user with this role; the trainee who made the call when `self` is set. */
  const actAs = (role: string, organizationId: string | null, opts: { isPlatformAdmin?: boolean; self?: boolean } = {}) => {
    const { id } = opts.self ? signIn(trainee) : signIn();
    // The trainee reports to the signed-in user, so a manager here is the rep's own manager.
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === id ? { id, role, organizationId, isPlatformAdmin: !!opts.isPlatformAdmin } : where.id === trainee ? { id: trainee, managerId: id } : null);
  };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test";
    trainee = signIn().id;
    row = { id: `s-${n}`, userId: trainee, organizationId: "org-1", scenarioId: scenario.id, transcript: longCall(8, 80), evaluation: AI_GRADE, overallScore: 64, updatedAt: new Date(1_000) };
    audits = [];
    for (const fn of [mocks.prisma.trainerSession.findUnique, mocks.prisma.trainerSession.update, mocks.prisma.user.findUnique, mocks.prisma.auditEvent.create, mocks.prisma.$transaction]) fn.mockReset();
    // Like Prisma on Postgres: each read is a copy; writes run only inside $transaction, in order, and the first that fails
    // stops the rest. update throws P2025 when the row no longer matches its where, and bumps updatedAt when it does.
    mocks.prisma.trainerSession.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === row.id ? { ...row } : null));
    mocks.prisma.trainerSession.update.mockImplementation(({ where, data }: { where: { id: string; updatedAt?: Date }; data: Partial<Row> }) => () => {
      if (where.id !== row.id || (where.updatedAt && where.updatedAt.getTime() !== row.updatedAt.getTime())) {
        throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: "test" });
      }
      Object.assign(row, data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
    });
    mocks.prisma.auditEvent.create.mockImplementation(({ data }: { data: (typeof audits)[number] }) => () => audits.push(data));
    mocks.prisma.$transaction.mockImplementation(async (ops: (() => unknown)[]) => {
      for (const op of ops) op();
    });
  });

  it("grades a 300-turn stored call on its opening turns with the cap note, instead of refusing it", async () => {
    actAs("manager", "org-1");
    row.transcript = longCall(300, 500);
    const res = await patch();
    expect(res.status).toBe(200);
    const { evaluation } = (await res.json()) as { evaluation: Evaluation };
    const note = "This call was longer than the grader reads, so only the first 240 of 300 turns were graded.";
    expect(evaluation).toMatchObject({ method: "llm", model: "gpt-test-mini", note });
    expect(promptOf()).toContain("Turn 240.");
    expect(promptOf()).not.toContain("Turn 241.");
    expect(row.evaluation).toMatchObject({ note });
  });

  it("grades a 300-turn call that fits the limits whole, with no cap note", async () => {
    actAs("manager", "org-1");
    row.transcript = longCall(300, 50);
    const res = await patch();
    expect(res.status).toBe(200);
    expect((await res.json()).evaluation.note).toBeUndefined();
    expect(promptOf()).toContain("Turn 300.");
  });

  it("still refuses an oversized request body", async () => {
    actAs("manager", "org-1");
    const res = await patch({ padding: "x".repeat(200_001) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("refuses the trainee on their AI-graded call, and allows them on a rules-based or ungraded one", async () => {
    actAs("trainee", "org-1", { self: true });
    for (const ev of [AI_GRADE, { ...AI_GRADE, model: undefined, graderVersion: undefined }]) {
      row.evaluation = ev;
      const res = await patch();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "regrade_not_allowed", message: NOT_ALLOWED });
    }
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.prisma.trainerSession.update).not.toHaveBeenCalled();

    row.evaluation = RULES_GRADE;
    expect((await patch()).status).toBe(200);
    row.evaluation = null;
    expect((await patch()).status).toBe(200);
  });

  /** Holds every model call until `count` have started, so each request reads the row before any of them saves. */
  const holdGrades = (count: number, beforeReply?: () => void) => {
    let release!: () => void;
    const allStarted = new Promise<void>((r) => (release = r));
    mocks.chat.mockImplementation(async () => {
      if (mocks.chat.mock.calls.length === count) release();
      await allStarted;
      beforeReply?.();
      return llmReply();
    });
  };

  it("saves only one of several re-grades the trainee sends at once, and answers the rest like a later request", async () => {
    actAs("trainee", "org-1", { self: true });
    row.evaluation = RULES_GRADE;
    row.overallScore = 41;
    holdGrades(3);
    const results = await Promise.all([patch(), patch(), patch()]);
    expect(mocks.chat).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403]);
    for (const res of results.filter((r) => r.status === 403)) expect(await res.json()).toEqual({ error: "regrade_not_allowed", message: NOT_ALLOWED });
    expect(row.evaluation).toMatchObject({ method: "llm" });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ previousMethod: "heuristic", previousScore: 41 });
  });

  it("doesn't save the trainee's re-grade when something else changed the call meanwhile, and says to reload", async () => {
    actAs("trainee", "org-1", { self: true });
    row.evaluation = null;
    // A manager saves a supervisor note while the model is grading.
    holdGrades(1, () => (row.updatedAt = new Date(row.updatedAt.getTime() + 1)));
    const res = await patch();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conflict");
    expect(row.evaluation).toBeNull();
    expect(audits).toHaveLength(0);
  });

  it("lets a manager's re-grade save even when the call changed after it was read", async () => {
    actAs("manager", "org-1");
    holdGrades(2);
    const results = await Promise.all([patch(), patch()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(mocks.prisma.trainerSession.update.mock.calls.map(([args]) => args.where)).toEqual([{ id: row.id }, { id: row.id }]);
    expect(audits).toHaveLength(2);
  });

  it("lets managers and owners of the same org, and platform admins, re-grade an AI grade", async () => {
    for (const [role, org, isPlatformAdmin] of [["manager", "org-1", false], ["owner", "org-1", false], ["trainee", null, true]] as const) {
      actAs(role, org, { isPlatformAdmin });
      expect((await patch()).status).toBe(200);
    }
    const audit = audits[0];
    expect(audit).toMatchObject({ action: "session.regraded", resource: row.id });
    expect(audit.metadata).toMatchObject({ trainee, previousMethod: "llm", previousModel: "gpt-test-mini" });
  });

  it("keeps everyone else out with the plain 403", async () => {
    for (const [role, org] of [["manager", "org-2"], ["trainee", "org-1"]] as const) {
      actAs(role, org);
      for (const ev of [AI_GRADE, RULES_GRADE]) {
        row.evaluation = ev;
        const res = await patch();
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe("Forbidden");
      }
    }
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});

describe("POST /api/evaluate-call", () => {
  const post = (transcript: unknown[]) =>
    evaluate(new NextRequest("http://localhost/api/evaluate-call", { method: "POST", body: JSON.stringify({ scenario, transcript }), headers: { "content-type": "application/json" } }));
  beforeEach(() => signIn());

  it("caps a long call through the shared helper, with the same note", async () => {
    const transcript = longCall(150, 900);
    const kept = gradable(transcript).length;
    expect(kept).toBe(Math.floor(GRADE_MAX_CHARS / 900));
    const res = await post(transcript);
    expect(res.status).toBe(200);
    const out = (await res.json()) as Evaluation;
    expect(out.method).toBe("llm");
    expect(out.note).toBe(gradedNote(undefined, kept, 150));
    expect(out.note).toBe(`This call was longer than the grader reads, so only the first ${kept} of 150 turns were graded.`);
    expect(promptOf()).toContain(`Turn ${kept}.`);
    expect(promptOf()).not.toContain(`Turn ${kept + 1}.`);
  });

  it("appends the cap line to the rules-based grader's own note", async () => {
    delete process.env.LLM_API_KEY;
    const transcript = longCall(150, 900);
    const out = (await (await post(transcript)).json()) as Evaluation;
    expect(out.method).toBe("heuristic");
    expect(out.note).toMatch(/^This is an automatic estimate.* This call was longer than the grader reads, so only the first 133 of 150 turns were graded\.$/);
  });

  it("grades a call that fits whole, with no note", async () => {
    const out = await (await post(longCall(300, 50))).json();
    expect(out).not.toHaveProperty("note");
    expect(promptOf()).toContain("Turn 300.");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed AI grade is marked (llmFailed) so the debrief shows a retry panel instead of a letter grade, and the
 * failure is logged with only a safe code. Only the model call is faked; grading logic runs for real.
 */

const mocks = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/llm")>()), chat: mocks.chat }));

import { evaluateCall, gradingFailureCode, type Evaluation } from "@/lib/grader";
import { debriefHeadline, isLlmFailedGrade, logbookScore, roughEstimateLabel } from "@/lib/grader-types";
import { sessionListItem, type SessionListRow } from "@/lib/sessionView";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { OPENAI_KEY_SLOT_VARS } from "@/lib/openaiKeys";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const CALL = [
  { role: "assistant" as const, text: scenario.aiPersona.openingLine },
  { role: "user" as const, text: "Thanks for calling, this is Sam. How long has it been leaking, and is the water shut off?" },
  { role: "assistant" as const, text: "Since this morning. What does a visit cost?" },
  { role: "user" as const, text: "The diagnostic fee is $89, credited toward the repair. How about 2 to 4 pm today?" },
];
const SECRET = "fixture-model-reply-text-0123";

let errors: unknown[][];
beforeEach(() => {
  for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", ...OPENAI_KEY_SLOT_VARS]) vi.stubEnv(k, "");
  mocks.chat.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const withKey = () => vi.stubEnv("LLM_API_KEY", "fixture-llm-key");

describe("evaluateCall marks a failed AI grade", () => {
  it("sets llmFailed and keeps the note when the model call throws an LLM error", async () => {
    withKey();
    mocks.chat.mockRejectedValue(new Error("LLM_HTTP_401"));
    const ev = await evaluateCall(scenario, CALL);
    expect(ev).toMatchObject({ method: "heuristic", llmFailed: true });
    expect(ev.note).toMatch(/rules-based estimate/);
    expect(errors).toEqual([["[grader] LLM grading failed, falling back to heuristic:", "LLM_HTTP_401"]]);
  });

  it("sets llmFailed on quota exhaustion too", async () => {
    withKey();
    mocks.chat.mockRejectedValue(new Error("LLM_QUOTA_EXHAUSTED"));
    expect((await evaluateCall(scenario, CALL)).llmFailed).toBe(true);
    expect(errors[0][1]).toBe("LLM_QUOTA_EXHAUSTED");
  });

  it("logs only the class name for a non-LLM error, never its message", async () => {
    withKey();
    // Braces with invalid JSON inside: extractJson's last JSON.parse throws a SyntaxError whose message quotes the reply.
    mocks.chat.mockResolvedValue(`{ ${SECRET} }`);
    const ev = await evaluateCall(scenario, CALL);
    expect(ev.llmFailed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(String(errors[0][1])).toMatch(/^non_llm_error:[A-Za-z]+$/);
    expect(JSON.stringify(errors)).not.toContain(SECRET);
  });

  it("does not set llmFailed when no model is configured", async () => {
    const ev = await evaluateCall(scenario, CALL);
    expect(ev.method).toBe("heuristic");
    expect(ev).not.toHaveProperty("llmFailed");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

describe("gradingFailureCode", () => {
  it("passes LLM_* codes through", () => {
    for (const code of ["LLM_HTTP_401", "LLM_HTTP_500", "LLM_QUOTA_EXHAUSTED", "LLM_BAD_RESPONSE", "LLM_BAD_JSON", "LLM_NOT_CONFIGURED"]) {
      expect(gradingFailureCode(new Error(code))).toBe(code);
    }
  });

  it("reduces anything else to its class name", () => {
    expect(gradingFailureCode(new SyntaxError(`Unexpected token in ${SECRET}`))).toBe("non_llm_error:SyntaxError");
    expect(gradingFailureCode(new TypeError("fetch failed"))).toBe("non_llm_error:TypeError");
    expect(gradingFailureCode(new Error(`LLM_HTTP_401 ${SECRET}`))).toBe("non_llm_error:Error");
    expect(gradingFailureCode("LLM_HTTP_401")).toBe("non_llm_error:string");
    expect(gradingFailureCode(null)).toBe("non_llm_error:object");
    const odd = new Error("x");
    odd.name = `Weird ${SECRET}`;
    expect(gradingFailureCode(odd)).toBe("non_llm_error:unknown");
  });
});

describe("isLlmFailedGrade", () => {
  it("is true only for a rules-based grade flagged as a failed AI grade", () => {
    expect(isLlmFailedGrade({ method: "heuristic", llmFailed: true })).toBe(true);
    expect(isLlmFailedGrade({ method: "heuristic" })).toBe(false);
    expect(isLlmFailedGrade({ method: "heuristic", llmFailed: false })).toBe(false);
    expect(isLlmFailedGrade({ method: "llm", llmFailed: true })).toBe(false);
    expect(isLlmFailedGrade(null)).toBe(false);
    expect(isLlmFailedGrade(undefined)).toBe(false);
  });
});

describe("debriefHeadline", () => {
  const base: Pick<Evaluation, "method" | "overallScore" | "grade"> = { method: "heuristic", overallScore: 23, grade: "F" };

  it("shows the retry panel with a rough estimate, never a letter, for a failed AI grade", () => {
    const h = debriefHeadline({ ...base, llmFailed: true });
    expect(h).toEqual({ kind: "catching_up", estimate: "Rough estimate (rules-based): 23/100" });
    expect(JSON.stringify(h)).not.toMatch(/"F"|grade/i);
  });

  it("shows the score ring for an AI grade and for a rules-based grade made without a model", () => {
    expect(debriefHeadline({ method: "llm", overallScore: 84, grade: "B" })).toEqual({ kind: "grade", score: 84, grade: "B" });
    expect(debriefHeadline(base)).toEqual({ kind: "grade", score: 23, grade: "F" });
  });

  it("reads older stored grades without the flag as before", () => {
    const legacy = JSON.parse(JSON.stringify({ ...base, summary: "x", criteria: [], strengths: [], improvements: [], goalAchievement: { achieved: false, explanation: "x" } })) as Evaluation;
    expect(debriefHeadline(legacy).kind).toBe("grade");
  });

  it("is ungraded with no evaluation", () => {
    expect(debriefHeadline(null)).toEqual({ kind: "ungraded" });
  });
});

describe("logbookScore (the dashboard history cell)", () => {
  it("shows Grading pending, never the score or letter, for a failed AI grade", () => {
    const cell = logbookScore({ score: 23, grade: "F", llmFailed: true });
    expect(cell).toEqual({ kind: "pending", label: "Grading pending" });
    expect(JSON.stringify(cell)).not.toMatch(/23|"F"/);
  });

  it("is pending even when no score was stored with the failed grade", () => {
    expect(logbookScore({ score: null, grade: null, llmFailed: true }).kind).toBe("pending");
  });

  it("shows the score and letter for any other graded call, as before", () => {
    expect(logbookScore({ score: 84, grade: "B", llmFailed: false })).toEqual({ kind: "score", score: 84, grade: "B", label: "Score 84, grade B" });
    expect(logbookScore({ score: 23, grade: "F", llmFailed: false })).toEqual({ kind: "score", score: 23, grade: "F", label: "Score 23, grade F" });
  });

  it("is Ungraded with no score", () => {
    expect(logbookScore({ score: null, grade: null, llmFailed: false })).toEqual({ kind: "ungraded", label: "Ungraded" });
  });
});

describe("GET /api/transcripts entries carry graderLlmFailed", () => {
  const row = (evaluation: unknown): SessionListRow => ({
    id: "s-1", scenarioId: "quote-follow-up", scenarioTitle: "Quote follow-up", scenarioCategory: null, durationSeconds: 60,
    overallScore: 23, grade: "F", goalAchieved: false, createdAt: new Date("2026-11-20T10:00:00Z"), evaluation, voiceTier: null,
  });

  it("is true only for a flagged rules-based grade, and the stored score and grade are unchanged", () => {
    const item = sessionListItem(row({ method: "heuristic", graderVersion: "heuristic-v2", llmFailed: true }));
    expect(item).toMatchObject({ graderLlmFailed: true, overallScore: 23, grade: "F", graderMethod: "heuristic" });
    expect(sessionListItem(row({ method: "heuristic", graderVersion: "heuristic-v2" })).graderLlmFailed).toBe(false);
    expect(sessionListItem(row({ method: "llm", graderVersion: "llm-v2", llmFailed: true })).graderLlmFailed).toBe(false);
    expect(sessionListItem(row({ method: "heuristic", llmFailed: "true" })).graderLlmFailed).toBe(false);
    expect(sessionListItem(row(null)).graderLlmFailed).toBe(false);
  });

  it("feeds logbookScore through isLlmFailedGrade the way the dashboard does", () => {
    const item = sessionListItem(row({ method: "heuristic", llmFailed: true }));
    const llmFailed = isLlmFailedGrade({ method: item.graderMethod, llmFailed: item.graderLlmFailed });
    expect(logbookScore({ score: item.overallScore, grade: item.grade, llmFailed })).toEqual({ kind: "pending", label: "Grading pending" });
  });
});

describe("roughEstimateLabel", () => {
  it("is a number out of 100, clamped and rounded", () => {
    expect(roughEstimateLabel(41)).toBe("Rough estimate (rules-based): 41/100");
    expect(roughEstimateLabel(41.6)).toBe("Rough estimate (rules-based): 42/100");
    expect(roughEstimateLabel(-5)).toBe("Rough estimate (rules-based): 0/100");
    expect(roughEstimateLabel(140)).toBe("Rough estimate (rules-based): 100/100");
  });
});

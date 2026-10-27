import { describe, expect, it } from "vitest";
import { sealEvaluation, stableStringify, verifySeal, type SealInput } from "@/lib/gradeSeal";

const KEY = "test-jwt-secret-that-is-long-enough-123";
const input: SealInput = {
  userId: "rep-1",
  scenarioId: "lib-water-heater",
  transcript: [{ role: "assistant", text: "Hi, my water heater died." }, { role: "user", text: "Sorry to hear that. When did it stop?" }],
  evaluation: { method: "llm", overallScore: 62, grade: "C", criteria: [{ id: "discovery", score: 55 }], goalAchievement: { achieved: false }, evaluatedAt: "2026-10-27T10:00:00.000Z" },
};

describe("grade seal", () => {
  it("verifies its own seal, also after a JSON round trip that reorders keys", () => {
    const seal = sealEvaluation(input, KEY)!;
    expect(seal).toMatch(/^[0-9a-f]{64}$/);
    const ev = input.evaluation as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify({ grade: ev.grade, ...ev }));
    expect(verifySeal({ ...input, evaluation: reordered }, seal, KEY)).toBe(true);
  });

  it("rejects an edited score, another user, another persona or another transcript", () => {
    const seal = sealEvaluation(input, KEY)!;
    expect(verifySeal({ ...input, evaluation: { ...(input.evaluation as object), overallScore: 100 } }, seal, KEY)).toBe(false);
    expect(verifySeal({ ...input, userId: "rep-2" }, seal, KEY)).toBe(false);
    expect(verifySeal({ ...input, scenarioId: "assigned-persona" }, seal, KEY)).toBe(false);
    expect(verifySeal({ ...input, transcript: [{ role: "user", text: "hi" }] }, seal, KEY)).toBe(false);
  });

  it("ignores transcript timestamps", () => {
    const seal = sealEvaluation(input, KEY)!;
    const stamped = input.transcript.map((t) => ({ ...t, timestamp: "2026-10-27T10:00:00.000Z" }));
    expect(verifySeal({ ...input, transcript: stamped }, seal, KEY)).toBe(true);
  });

  it("rejects missing or malformed seals and a missing key", () => {
    expect(verifySeal(input, undefined, KEY)).toBe(false);
    expect(verifySeal(input, "not-hex", KEY)).toBe(false);
    expect(verifySeal(input, "0".repeat(64), KEY)).toBe(false);
    expect(sealEvaluation(input, undefined)).toBeUndefined();
    expect(verifySeal(input, sealEvaluation(input, KEY), undefined)).toBe(false);
  });

  it("stableStringify sorts keys and drops undefined values", () => {
    expect(stableStringify({ b: 1, a: [2, undefined, { d: undefined, c: "x" }] })).toBe('{"a":[2,null,{"c":"x"}],"b":1}');
  });
});

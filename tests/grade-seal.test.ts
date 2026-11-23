import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GRADE_SEAL_MAX_AGE_MS, isSealFresh, sealEvaluation, stableStringify, transcriptDigest, verifySeal, type SealInput } from "@/lib/gradeSeal";

const KEY = "test-jwt-secret-that-is-long-enough-123";
const EVALUATED_AT = "2026-10-27T10:00:00.000Z";
/** A moment shortly after the grade, so the freshness check passes unless a test moves it. */
const NOW = Date.parse(EVALUATED_AT) + 60_000;
const input: SealInput = {
  userId: "rep-1",
  sessionId: "text-1761559200000-0123456789abcdef01234567",
  scenarioId: "lib-water-heater",
  transcript: [{ role: "assistant", text: "Hi, my water heater died." }, { role: "user", text: "Sorry to hear that. When did it stop?" }],
  evaluation: { method: "llm", overallScore: 62, grade: "C", criteria: [{ id: "discovery", score: 55 }], goalAchievement: { achieved: false }, evaluatedAt: EVALUATED_AT },
};
const at = (evaluatedAt: unknown): SealInput => ({ ...input, evaluation: { ...(input.evaluation as object), evaluatedAt } });

describe("grade seal", () => {
  it("verifies its own seal, also after a JSON round trip that reorders keys", () => {
    const seal = sealEvaluation(input, KEY)!;
    expect(seal).toMatch(/^[0-9a-f]{64}$/);
    const ev = input.evaluation as Record<string, unknown>;
    const reordered = JSON.parse(JSON.stringify({ grade: ev.grade, ...ev }));
    expect(verifySeal({ ...input, evaluation: reordered }, seal, KEY, NOW)).toBe(true);
  });

  it("rejects an edited score, another user, another call, another persona or another transcript", () => {
    const seal = sealEvaluation(input, KEY)!;
    expect(verifySeal({ ...input, evaluation: { ...(input.evaluation as object), overallScore: 100 } }, seal, KEY, NOW)).toBe(false);
    expect(verifySeal({ ...input, userId: "rep-2" }, seal, KEY, NOW)).toBe(false);
    expect(verifySeal({ ...input, sessionId: "text-1761559200000-ffffffffffffffffffffffff" }, seal, KEY, NOW)).toBe(false);
    expect(verifySeal({ ...input, sessionId: "" }, seal, KEY, NOW)).toBe(false);
    expect(verifySeal({ ...input, scenarioId: "assigned-persona" }, seal, KEY, NOW)).toBe(false);
    expect(verifySeal({ ...input, transcript: [{ role: "user", text: "hi" }] }, seal, KEY, NOW)).toBe(false);
  });

  it("ignores transcript timestamps", () => {
    const seal = sealEvaluation(input, KEY)!;
    const stamped = input.transcript.map((t) => ({ ...t, timestamp: "2026-10-27T10:00:00.000Z" }));
    expect(verifySeal({ ...input, transcript: stamped }, seal, KEY, NOW)).toBe(true);
  });

  it("rejects missing or malformed seals and a missing key, and seals nothing without a sessionId", () => {
    expect(verifySeal(input, undefined, KEY, NOW)).toBe(false);
    expect(verifySeal(input, "not-hex", KEY, NOW)).toBe(false);
    expect(verifySeal(input, "0".repeat(64), KEY, NOW)).toBe(false);
    expect(sealEvaluation(input, undefined)).toBeUndefined();
    expect(sealEvaluation({ ...input, sessionId: "" }, KEY)).toBeUndefined();
    expect(verifySeal(input, sealEvaluation(input, KEY), undefined, NOW)).toBe(false);
  });

  it("no longer verifies a v1 seal (made before the sessionId was bound)", () => {
    const v1Payload = stableStringify({ v: "grade-seal-v1", u: input.userId, s: input.scenarioId, t: transcriptDigest(input.transcript), e: input.evaluation });
    const v1 = createHmac("sha256", KEY).update(v1Payload).digest("hex");
    expect(verifySeal(input, v1, KEY, NOW)).toBe(false);
  });

  it(`accepts a grade up to ${GRADE_SEAL_MAX_AGE_MS / 60_000} minutes old and rejects an older, future, missing or unparseable one`, () => {
    const t = Date.parse(EVALUATED_AT);
    const sealAt = (v: unknown) => sealEvaluation(at(v), KEY)!;
    expect(GRADE_SEAL_MAX_AGE_MS).toBe(30 * 60_000);
    // Fresh: just graded, 29 minutes ago, exactly at the limit, or a few seconds ahead of this server's clock.
    for (const now of [t, t + 29 * 60_000, t + GRADE_SEAL_MAX_AGE_MS, t - 30_000]) expect(verifySeal(input, sealEvaluation(input, KEY), KEY, now)).toBe(true);
    // Stale: older than 30 minutes. Future: more than the skew ahead.
    expect(verifySeal(input, sealEvaluation(input, KEY), KEY, t + GRADE_SEAL_MAX_AGE_MS + 1)).toBe(false);
    expect(verifySeal(input, sealEvaluation(input, KEY), KEY, t + 31 * 60_000)).toBe(false);
    expect(verifySeal(input, sealEvaluation(input, KEY), KEY, t - 5 * 60_000)).toBe(false);
    // The server's own seal over a missing or unparseable evaluatedAt still doesn't verify.
    for (const bad of [undefined, null, "", "yesterday", 1_761_559_200_000]) expect(verifySeal(at(bad), sealAt(bad), KEY, NOW)).toBe(false);
    expect(isSealFresh(null, NOW)).toBe(false);
    expect(isSealFresh({ evaluatedAt: EVALUATED_AT }, NOW)).toBe(true);
  });

  it("stableStringify sorts keys and drops undefined values", () => {
    expect(stableStringify({ b: 1, a: [2, undefined, { d: undefined, c: "x" }] })).toBe('{"a":[2,null,{"c":"x"}],"b":1}');
  });
});

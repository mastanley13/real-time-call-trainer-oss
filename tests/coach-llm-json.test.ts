import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The live coach's LLM path: structured outputs on the OpenAI base (json_object fallback on a 400 about
 * response_format), tolerant parsing, one retry for an unusable reply inside the 15 s budget, and log lines that
 * carry only a safe code. No network: fetch is stubbed, keys are fixtures.
 */

import { COACH_JSON_SCHEMA, coachFailureCode, coachTurn, parseCoachReply, type CoachTurnInput } from "@/lib/coach";
import { parseFirstJsonObject } from "@/lib/llm";
import { OPENAI_KEY_SLOT_VARS, resetOpenAiKeyState } from "@/lib/openaiKeys";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const hex = (n: number) => randomBytes(n).toString("hex");
const KEY = `${hex(8)}fixturecoachkey${hex(8)}`;
const CANARY = `CANARYREPLY${hex(6)}`;
const CUSTOM_BASE = "https://llm.fixture.example/v1";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const TRAINEE_LINE = "Thanks for calling, this is Sam. How long has it been leaking, and is the water shut off?";
const CALL: CoachTurnInput[] = [
  { role: "assistant", text: scenario.aiPersona.openingLine },
  { role: "user", text: TRAINEE_LINE },
  { role: "assistant", text: "Since this morning. What does a visit cost?" },
];

const validReply = () =>
  JSON.stringify({
    criteria: scenario.rubric.map((c) => ({ id: c.id, score: 40, quote: c === scenario.rubric[0] ? "How long has it been leaking" : null })),
    steps: [true],
    cue: {
      type: "objection",
      title: "Explain the fee",
      message: "Answer the price question before booking.",
      suggestedLine: "The diagnostic visit is $89.",
      triggerTurn: 3,
      criterionId: null,
      key: "objection:price",
    },
  });

const completion = (content: string | null, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200, headers: { "content-type": "application/json" } });
const errorResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Sent = { url: string; body: Record<string, unknown>; auth: string };
let sent: Sent[];
let logs: string[];

/** Stubs fetch with one responder per call, in order; the last one repeats. */
function replies(...rs: (() => Response | Promise<Response>)[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
      return rs[Math.min(sent.length - 1, rs.length - 1)]();
    }),
  );
}

const run = () => coachTurn(scenario, CALL, { allowCue: true });
const logText = () => logs.join("\n");

beforeEach(() => {
  for (const k of ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", ...OPENAI_KEY_SLOT_VARS]) vi.stubEnv(k, "");
  vi.stubEnv("LLM_API_KEY", KEY);
  resetOpenAiKeyState();
  sent = [];
  logs = [];
  for (const m of ["error", "warn", "info", "log"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
  }
});

afterEach(() => {
  // The canary from a bad reply or provider body must never reach a log line.
  expect(logText()).not.toContain(CANARY);
  expect(logText()).not.toContain(KEY);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseFirstJsonObject", () => {
  it("strips code fences", () => {
    expect(parseFirstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseFirstJsonObject('Here it is:\n```\n{"a":{"b":[1,2]}}\n```\nDone.')).toEqual({ a: { b: [1, 2] } });
  });

  it("ignores prose before and text after the object", () => {
    expect(parseFirstJsonObject(`Sure, here is the JSON: {"a":"x"} Hope that helps. ${CANARY}`)).toEqual({ a: "x" });
    expect(parseFirstJsonObject('{"a":1} and another {"b":2}')).toEqual({ a: 1 });
    expect(parseFirstJsonObject('{"a":1}}}} trailing')).toEqual({ a: 1 });
  });

  it("matches braces string-aware, with escapes", () => {
    const obj = { a: "}{ \"quoted\" \\", b: { c: "{{" } };
    expect(parseFirstJsonObject(`prefix ${JSON.stringify(obj)} suffix }`)).toEqual(obj);
  });

  it("skips a brace span in prose that is not JSON", () => {
    expect(parseFirstJsonObject(`Note {${CANARY}}: {"a":1}`)).toEqual({ a: 1 });
  });

  it("rejects truncated JSON without returning a nested object", () => {
    expect(() => parseFirstJsonObject('{"criteria":[{"id":"a","score":5,"quote":"x"},{"id":"b"')).toThrow("LLM_BAD_JSON");
    expect(() => parseFirstJsonObject('```json\n{"criteria":[{"id":"a"}')).toThrow("LLM_BAD_JSON");
  });

  it("throws LLM_EMPTY or LLM_BAD_JSON, never a SyntaxError that quotes the reply", () => {
    expect(() => parseFirstJsonObject("  \n ")).toThrow("LLM_EMPTY");
    for (const bad of [CANARY, `{ ${CANARY} }`, "[1,2]"]) {
      let err: unknown;
      try {
        parseFirstJsonObject(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("Error");
      expect((err as Error).message).toBe("LLM_BAD_JSON");
    }
  });
});

describe("parseCoachReply", () => {
  it("accepts the nullable fields of the strict schema", () => {
    const out = parseCoachReply(validReply(), false);
    expect(out.criteria).toHaveLength(scenario.rubric.length);
    expect(out.criteria[1].quote).toBeNull();
  });

  it("classifies empty, truncated, bad JSON and schema failures", () => {
    expect(() => parseCoachReply("", false)).toThrow("LLM_EMPTY");
    expect(() => parseCoachReply("", true)).toThrow("LLM_TRUNCATED");
    expect(() => parseCoachReply('{"criteria":[{"id":"a"', true)).toThrow("LLM_TRUNCATED");
    expect(() => parseCoachReply(`No JSON here ${CANARY}`, false)).toThrow("LLM_BAD_JSON");
    expect(() => parseCoachReply(JSON.stringify({ criteria: CANARY, steps: [], cue: null }), false)).toThrow("LLM_SCHEMA");
  });
});

describe("coachFailureCode", () => {
  it("passes our codes through and reduces anything else to its class", () => {
    expect(coachFailureCode(new Error("LLM_HTTP_500"))).toBe("LLM_HTTP_500");
    expect(coachFailureCode(new Error("COACH_LLM_TIMEOUT"))).toBe("COACH_LLM_TIMEOUT");
    expect(coachFailureCode(new SyntaxError(`Unexpected token "${CANARY}"`))).toBe("non_llm_error:SyntaxError");
    expect(coachFailureCode(z.object({ a: z.number() }).safeParse({ a: CANARY }).error)).toBe("LLM_SCHEMA");
  });
});

/** Every object in a strict schema lists all its properties as required and forbids extras. */
function assertStrict(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n.type === "object") {
    expect(n.additionalProperties).toBe(false);
    expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
  }
  for (const v of Object.values(n)) (Array.isArray(v) ? v : [v]).forEach(assertStrict);
}

describe("coach request format", () => {
  it("sends a strict json_schema on the OpenAI base", async () => {
    replies(() => completion(validReply()));
    const r = await run();
    expect(r.source).toBe("llm");
    expect(r.cue?.type).toBe("objection");
    expect(sent).toHaveLength(1);
    const rf = sent[0].body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema).toEqual({ name: "coach_turn", strict: true, schema: COACH_JSON_SCHEMA.schema });
    assertStrict(rf.json_schema.schema);
    expect(sent[0].body.max_completion_tokens).toBe(1000);
    expect(sent[0].body.model).toBe("gpt-6-luna");
  });

  it("keeps json_object on a custom base", async () => {
    vi.stubEnv("LLM_BASE_URL", CUSTOM_BASE);
    replies(() => completion(validReply()));
    expect((await run()).source).toBe("llm");
    expect(sent[0].body.response_format).toEqual({ type: "json_object" });
    expect(sent[0].body.max_tokens).toBe(1000);
  });

  it("retries once on the same key with json_object after a 400 about response_format", async () => {
    replies(
      () => errorResponse(400, { error: { message: `Invalid parameter: 'response_format' of type 'json_schema' is not supported. ${CANARY}`, type: "invalid_request_error", param: "response_format" } }),
      () => completion(validReply()),
    );
    expect((await run()).source).toBe("llm");
    expect(sent).toHaveLength(2);
    expect((sent[0].body.response_format as { type: string }).type).toBe("json_schema");
    expect(sent[1].body.response_format).toEqual({ type: "json_object" });
    expect(sent[1].auth).toBe(sent[0].auth);
    expect(sent[1].body.temperature).toBe(0.2);
  });

  it("does not retry the format on an unrelated 400", async () => {
    replies(() => errorResponse(400, { error: { message: `Something else ${CANARY}`, type: "invalid_request_error" } }));
    expect((await run()).source).toBe("heuristic");
    expect(sent).toHaveLength(1);
    expect(logText()).toContain("LLM_HTTP_400");
  });
});

describe("coach retry", () => {
  it("retries an empty truncated reply with a larger budget and uses the second reply", async () => {
    replies(() => completion("", "length"), () => completion(validReply()));
    const r = await run();
    expect(r.source).toBe("llm");
    expect(sent.map((s) => s.body.max_completion_tokens)).toEqual([1000, 2000]);
    expect(logText()).toContain("LLM_TRUNCATED");
  });

  it("retries an empty reply with a larger budget", async () => {
    replies(() => completion("   "), () => completion(validReply()));
    expect((await run()).source).toBe("llm");
    expect(sent.map((s) => s.body.max_completion_tokens)).toEqual([1000, 2000]);
    expect(logText()).toContain("LLM_EMPTY");
  });

  it("retries bad JSON with the same budget and parses fenced output with prose on the retry", async () => {
    replies(() => completion(`I think the rep is doing well. ${CANARY}`), () => completion(`Here you go:\n\`\`\`json\n${validReply()}\n\`\`\`\nAnything else?`));
    expect((await run()).source).toBe("llm");
    expect(sent.map((s) => s.body.max_completion_tokens)).toEqual([1000, 1000]);
  });

  it("falls back to the heuristic after two bad replies, logging only the code", async () => {
    replies(() => completion(`{ ${CANARY} }`));
    const r = await run();
    expect(r.source).toBe("heuristic");
    expect(sent).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith("[coach]"))).toEqual([
      "[coach] LLM coach reply unusable, retrying once: LLM_BAD_JSON",
      "[coach] LLM coach failed, falling back to heuristic: LLM_BAD_JSON",
    ]);
  });

  it("falls back after two schema failures without logging the values", async () => {
    replies(() => completion(JSON.stringify({ criteria: [{ id: "a", score: 1, quote: { nested: CANARY } }], steps: [], cue: null })));
    expect((await run()).source).toBe("heuristic");
    expect(sent).toHaveLength(2);
    expect(logText()).toContain("heuristic: LLM_SCHEMA");
  });

  it("does not retry when every OpenAI key is out of quota", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", KEY);
    replies(() => errorResponse(429, { error: { message: CANARY, type: "insufficient_quota", code: "insufficient_quota" } }));
    expect((await run()).source).toBe("heuristic");
    expect(sent).toHaveLength(1);
    expect(logText()).toContain("heuristic: LLM_QUOTA_EXHAUSTED");
  });

  it.each([401, 403])("does not retry on HTTP %i", async (status) => {
    replies(() => errorResponse(status, { error: { message: CANARY, type: "authentication_error" } }));
    expect((await run()).source).toBe("heuristic");
    expect(sent).toHaveLength(1);
    expect(logText()).toContain(`heuristic: LLM_HTTP_${status}`);
  });

  it("does not retry when the not-configured path is hit", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    replies(() => completion(validReply()));
    expect((await run()).source).toBe("heuristic");
    expect(sent).toHaveLength(0);
  });
});

describe("coach time budget", () => {
  const delayed = (ms: number, r: () => Response) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(r()), ms));

  it("skips the retry when too little of the 15 s budget is left", async () => {
    vi.useFakeTimers();
    replies(delayed(13_000, () => completion("", "length")), () => completion(validReply()));
    const p = run();
    await vi.advanceTimersByTimeAsync(13_000);
    const r = await p;
    expect(r.source).toBe("heuristic");
    expect(sent).toHaveLength(1);
    expect(logText()).toContain("heuristic: LLM_TRUNCATED");
  });

  it("gives the retry only the remaining time, so the whole path ends at 15 s", async () => {
    vi.useFakeTimers();
    replies(delayed(5_000, () => completion(`no json ${CANARY}`)), () => new Promise<Response>(() => {}));
    let done = false;
    const p = run().then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(sent).toHaveLength(2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
    const r = await p;
    expect(r.source).toBe("heuristic");
    expect(logText()).toContain("heuristic: COACH_LLM_TIMEOUT");
  });

  it("times out a single slow reply at 15 s without a retry", async () => {
    vi.useFakeTimers();
    replies(() => new Promise<Response>(() => {}));
    const p = run();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).source).toBe("heuristic");
    expect(sent).toHaveLength(1);
  });
});

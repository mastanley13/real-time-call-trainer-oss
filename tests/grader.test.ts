import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The model call, the database and the session check are the only fakes; grading logic runs for real.
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

import { detectSlotOffer, evaluateCall, gradeHeuristically, type Turn } from "@/lib/grader";
import { GRADER_VERSIONS, graderLabel, type Evaluation } from "@/lib/grader-types";
import { BUILT_IN_SCENARIOS, type Scenario } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { PATCH } from "@/app/api/transcripts/[id]/route";
import { POST as checkConnection } from "@/app/api/llm/check/route";
import type { LlmCheckResult } from "@/app/api/llm/hints";
import { jobRows, voiceEngines } from "@/components/settings/models";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const OFFER = "How about a 2 to 4 pm window this afternoon?";
const FEE = "The diagnostic fee is $89, and it's credited toward the repair.";

// A system turn first, so line numbers must count it (the debrief numbers every stored turn).
const CALL: Turn[] = [
  { role: "system", text: "Call connected." },
  { role: "assistant", text: scenario.aiPersona.openingLine },
  { role: "user", text: "Thanks for calling Apex Plumbing, this is Sam. I'm sorry to hear that. How long has it been leaking, and is the water shut off?" },
  { role: "assistant", text: "It started this morning. I haven't touched the valve." },
  { role: "user", text: "How old is the unit, and where is the leak coming from?" },
  { role: "assistant", text: "About eleven years. It's at the base. What does a visit cost?" },
  { role: "user", text: `${FEE} ${OFFER}` },
  { role: "assistant", text: "Let me check with my partner first." },
];
const OFFER_LINE = CALL.findIndex((t) => t.text.includes(OFFER)) + 1;
const close = (ev: Evaluation) => ev.criteria.find((c) => c.id === "close")!;

/** A well-formed model reply: one real quote and one invented quote per criterion. */
const llmReply = (rubric = scenario.rubric) =>
  JSON.stringify({
    summary: "You handled the call calmly.",
    criteria: rubric.map((c) => ({
      id: c.id,
      score: 72,
      rationale: "You made a solid attempt.",
      evidence: [{ speaker: "trainee", quote: OFFER }, { speaker: "trainee", quote: "We will fix it for free, guaranteed." }],
    })),
    strengths: ["You offered a concrete slot."],
    improvements: ["Confirm the booking out loud."],
    goalStatus: "partial",
    goalExplanation: "You offered a slot that was not confirmed.",
  });

const ENV_KEYS = ["LLM_API_KEY", "OPENAI_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "DATABASE_URL", "DEMO_MODE", "RATE_LIMIT_GRADING_MAX"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RATE_LIMIT_GRADING_MAX = "1000";
  mocks.chat.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  vi.unstubAllGlobals();
});
const withKey = () => {
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "gpt-test-mini";
};

describe("heuristic grader", () => {
  it("quotes the trainee verbatim with the transcript's own line numbers", () => {
    const ev = gradeHeuristically(scenario, CALL);
    const evidence = ev.criteria.flatMap((c) => c.evidence);
    expect(evidence.length).toBeGreaterThan(2);
    for (const e of evidence) {
      expect(e.speaker).toBe("trainee");
      const turn = CALL[e.line! - 1];
      expect(turn.role).toBe("user");
      expect(turn.text).toContain(e.quote.replace(/\.\.\.$/, ""));
    }
  });

  it("gives partial booking credit for an offered slot and more once it is confirmed", () => {
    const noSlot = gradeHeuristically(scenario, CALL.map((t) => (t.text.includes(OFFER) ? { ...t, text: FEE } : t)));
    const offered = gradeHeuristically(scenario, CALL);
    const confirmed = gradeHeuristically(scenario, [...CALL, { role: "user", text: "Great, you're all set for 2 to 4 pm today." }]);

    expect(close(noSlot).score).toBeLessThan(60);
    expect(close(offered).score).toBeGreaterThanOrEqual(60);
    expect(close(offered).score).toBeLessThan(80);
    expect(close(offered).rationale).toMatch(/partial credit/);
    expect(close(offered).evidence[0]).toMatchObject({ quote: OFFER, line: OFFER_LINE });
    expect(close(confirmed).score).toBeGreaterThanOrEqual(80);
    expect(offered.goalAchievement.status).not.toBe("not_achieved");
  });

  it("credits a real apology on a criterion that asks for one, and quotes it", () => {
    const ines = LIBRARY.find((s) => s.id === "cs-angry-escalation-fulfillment-outage")!;
    const ownership = (ev: Evaluation) => ev.criteria.find((c) => c.id === "ownership")!;
    const call = (...rep: string[]): Turn[] => rep.flatMap((text): Turn[] => [{ role: "assistant", text: "Go on." }, { role: "user", text }]);
    const base = ["Thanks for staying on the line. Can you walk me through which orders were affected?", "I'll have an engineer on it and send updates every hour."];
    const without = gradeHeuristically(ines, call(...base));
    const sorry = "I'm sorry about Tuesday, six hours down is not acceptable.";
    const withApology = gradeHeuristically(ines, call(sorry, ...base));
    expect(ownership(withApology).score).toBeGreaterThan(ownership(without).score);
    expect(ownership(withApology).evidence[0].quote).toBe(sorry);
    expect(ownership(withApology).rationale).toMatch(/^You apologized plainly and addressed \d+ of \d+ expected points/);
    // A deflection dressed as an apology earns nothing; owning the miss after "sorry, but" still does.
    // (No rubric words in it: keyword coverage would credit "queue" or "ticket" on its own.)
    const deflect = gradeHeuristically(ines, call("I'm sorry, but that's just how it works here.", ...base));
    expect(ownership(deflect).score).toBe(ownership(without).score);
    expect(ownership(gradeHeuristically(ines, call("I'm sorry you feel that way.", ...base))).score).toBe(ownership(without).score);
    expect(ownership(gradeHeuristically(ines, call("I'm sorry, but we dropped the ball on Tuesday.", ...base))).score).toBeGreaterThan(ownership(without).score);
    // Asking the caller to repeat is not an apology.
    const repeat = gradeHeuristically(ines, call("Sorry, could you repeat that?", ...base));
    expect(ownership(repeat).score).toBe(ownership(without).score);
    // "Apologizes once": apologizing in every turn earns less than once.
    const constant = gradeHeuristically(ines, call(sorry, "I'm so sorry about this.", "I apologize again.", ...base));
    expect(ownership(constant).score).toBeLessThan(ownership(withApology).score);
  });

  it.each([
    "States the fee without discounting, hedging, or apologizing for it.",
    "Avoids apologizing for the fee.",
    "Doesn't apologize for the price.",
    "Makes no apology for the price and moves on.",
    "Keeps the fee conversation apology-free.",
    "Refrains from apologizing for the fee.",
  ])("does not reward an apology on the criterion %j", (description) => {
    const priceFirm: Scenario = { ...scenario, rubric: [{ id: "firm", name: "Holds the price", description, weight: 100 }] };
    const plain = gradeHeuristically(priceFirm, [{ role: "user", text: "The fee is $89, credited toward the repair." }]);
    const sorry = gradeHeuristically(priceFirm, [{ role: "user", text: "I'm so sorry, the fee is $89, credited toward the repair." }]);
    expect(sorry.criteria[0].score).toBeLessThanOrEqual(plain.criteria[0].score);
  });

  it("penalises padding the call with the same sentence", () => {
    const clean = gradeHeuristically(scenario, CALL);
    const padded = gradeHeuristically(scenario, [...CALL, ...Array.from({ length: 5 }, (): Turn[] => [{ role: "user", text: FEE }, { role: "assistant", text: "Okay." }]).flat()]);
    expect(padded.overallScore).toBeLessThan(clean.overallScore);
    expect(padded.criteria.some((c) => /repeated yourself/.test(c.rationale))).toBe(true);
  });

  it("records no model on a rules-based grade", async () => {
    const ev = gradeHeuristically(scenario, CALL);
    expect(ev.method).toBe("heuristic");
    expect(ev.model).toBeUndefined();
    const viaEntry = await evaluateCall(scenario, CALL); // no key configured
    expect(viaEntry.method).toBe("heuristic");
    expect(viaEntry).not.toHaveProperty("model");
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});

describe("slot offer detection", () => {
  const at = (...texts: string[]) => detectSlotOffer(texts.map((text, i) => ({ text, line: i + 1 })));
  it.each([
    "Can I send a tech over Saturday at 10am?",
    "I can show it Saturday morning.",
    "We can come by tomorrow at 9am.",
    "How about Thursday at 2pm?",
  ])("counts %j as a slot offer", (text) => {
    expect(at(text).offered?.line).toBe(1);
  });
  it("needs a concrete time, not just an offer verb", () => {
    expect(at("Can I send you the brochure?").offered).toBeUndefined();
  });
});

describe("LLM grader", () => {
  it("records the grading model and keeps only quotes found in the transcript", async () => {
    withKey();
    mocks.chat.mockResolvedValue(llmReply());
    const ev = await evaluateCall(scenario, CALL);
    expect(mocks.chat).toHaveBeenCalledOnce();
    expect(ev).toMatchObject({ method: "llm", model: "gpt-test-mini", graderVersion: GRADER_VERSIONS.llm });
    for (const c of ev.criteria) expect(c.evidence).toEqual([{ speaker: "trainee", quote: OFFER, line: OFFER_LINE }]);
    expect(ev.goalAchievement.status).toBe("partial");
  });

  it("falls back to the rules-based grader, without a model, when the model call fails", async () => {
    withKey();
    mocks.chat.mockRejectedValue(new Error("LLM_HTTP_500"));
    const ev = await evaluateCall(scenario, CALL);
    expect(ev.method).toBe("heuristic");
    expect(ev.model).toBeUndefined();
    expect(ev.note).toMatch(/rules-based estimate/);
  });

  it("labels provenance from the stored grade, not the current config", () => {
    expect(graderLabel({ method: "llm", model: "gpt-4.1-mini" })).toBe("gpt-4.1-mini");
    expect(graderLabel({ method: "llm" })).toBe("AI (model not recorded)");
    expect(graderLabel({ method: "heuristic", model: "ignored" })).toBe("rules-based");
  });
});

describe("PATCH /api/transcripts/[id] (server re-grade)", () => {
  let n = 0;
  type Row = { id: string; userId: string; organizationId: string; scenarioId: string; transcript: unknown; evaluation: unknown; overallScore: number | null };
  let row: Row;

  /** Signs in a fresh user per test so the per-user limit never leaks between tests. */
  const signIn = (id = `u-${++n}`) => (mocks.user = { id, email: `${id}@example.test` });
  const patch = (body: unknown, id = row.id) =>
    PATCH(new NextRequest(`http://localhost/api/transcripts/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", "user-agent": "vitest" } }), { params: Promise.resolve({ id }) });

  beforeEach(() => {
    withKey();
    process.env.DATABASE_URL = "postgres://test";
    const owner = signIn();
    row = { id: `s-${n}`, userId: owner.id, organizationId: "org-1", scenarioId: scenario.id, transcript: CALL, evaluation: { method: "heuristic", overallScore: 41 }, overallScore: 41 };
    for (const fn of [mocks.prisma.trainerSession.findUnique, mocks.prisma.trainerSession.update, mocks.prisma.user.findUnique, mocks.prisma.auditEvent.create, mocks.prisma.$transaction]) fn.mockReset();
    mocks.prisma.trainerSession.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === row.id ? row : null));
    mocks.prisma.trainerSession.update.mockImplementation(async (args: unknown) => args);
    mocks.prisma.auditEvent.create.mockImplementation(async (args: unknown) => args);
    mocks.prisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
    mocks.chat.mockResolvedValue(llmReply());
  });

  it("grades the stored transcript, saves the grade and writes an audit event", async () => {
    const res = await patch({ evaluation: { overallScore: 100, grade: "A", method: "llm" }, transcript: [{ role: "user", text: "ignored" }] });
    expect(res.status).toBe(200);
    const { evaluation } = (await res.json()) as { evaluation: Evaluation };
    expect(evaluation).toMatchObject({ method: "llm", model: "gpt-test-mini" });
    expect(evaluation.overallScore).toBe(72); // from the model's scores, not the client's 100
    expect(evaluation.evaluatedAt).toBeTruthy();
    expect(mocks.chat.mock.calls[0][0][1].content).toContain("How old is the unit");

    const update = mocks.prisma.trainerSession.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: row.id });
    expect(update.data).toMatchObject({ overallScore: 72, grade: "C", goalAchieved: false, evaluation: { model: "gpt-test-mini" } });
    const audit = mocks.prisma.auditEvent.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ userId: mocks.user.id, action: "session.regraded", resource: row.id, userAgent: "vitest" });
    expect(audit.metadata).toMatchObject({ previousScore: 41, overallScore: 72, model: "gpt-test-mini", scenarioSource: "library" });
  });

  it("uses the server's library persona over a client-sent copy with a looser rubric", async () => {
    const loose: Scenario = { ...scenario, rubric: [{ id: "anything", name: "Anything", description: "", weight: 100 }] };
    const res = await patch({ scenario: loose });
    expect(res.status).toBe(200);
    const { evaluation } = (await res.json()) as { evaluation: Evaluation };
    expect(evaluation.criteria.map((c) => c.id)).toEqual(scenario.rubric.map((c) => c.id));
  });

  it("needs the matching scenario for a custom persona", async () => {
    const custom: Scenario = { ...scenario, id: "custom-abc", builtIn: false };
    row.scenarioId = custom.id;
    expect((await patch({})).status).toBe(400);
    expect((await patch({ scenario: { ...custom, id: "custom-other" } })).status).toBe(400);
    const ok = await patch({ scenario: custom });
    expect(ok.status).toBe(200);
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data.metadata.scenarioSource).toBe("client");
  });

  it("allows the owner, the rep's manager, same-org owners and platform admins only", async () => {
    const actor = (role: string, organizationId: string | null, isPlatformAdmin = false) => {
      signIn();
      const me = { id: mocks.user.id, role, organizationId, isPlatformAdmin };
      // The rep reports to the signed-in user, so a manager here is the rep's own manager.
      mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === me.id ? me : { id: where.id, managerId: me.id }));
    };
    actor("trainee", "org-1");
    expect((await patch({})).status).toBe(403);
    actor("manager", "org-2");
    expect((await patch({})).status).toBe(403);
    actor("manager", "org-1");
    expect((await patch({})).status).toBe(200);
    actor("owner", "org-1");
    expect((await patch({})).status).toBe(200);
    actor("trainee", null, true);
    expect((await patch({})).status).toBe(200);
    expect((await patch({}, "missing")).status).toBe(404);
  });

  it("keeps the stored grade when AI grading fails", async () => {
    mocks.chat.mockRejectedValue(new Error("LLM_HTTP_429"));
    const res = await patch({});
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/wasn't changed/);
    expect(mocks.prisma.trainerSession.update).not.toHaveBeenCalled();
  });

  it("refuses without a key, and in demo mode", async () => {
    delete process.env.LLM_API_KEY;
    expect((await patch({})).status).toBe(503);
    withKey();
    signIn("demo-user");
    expect((await patch({})).status).toBe(400);
    expect(mocks.prisma.trainerSession.findUnique).not.toHaveBeenCalled();
  });

  it("rate limits each user", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await patch({})).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("POST /api/llm/check", () => {
  let ip = 0;
  const check = async (headers: Record<string, string> = {}) => {
    const res = await checkConnection(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": `10.1.0.${++ip}`, ...headers } }));
    return { res, body: (await res.json()) as LlmCheckResult & { error?: string } };
  };
  const provider = (status: number, body: unknown = {}) => {
    const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("explains a missing key without calling the provider", async () => {
    const fn = provider(200);
    const { body } = await check();
    expect(body).toMatchObject({ ok: false, status: null, latencyMs: null });
    expect(body.hint).toMatch(/LLM_API_KEY/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("makes one minimal completion and reports latency", async () => {
    withKey();
    const fn = provider(200, { choices: [{ message: { content: "O" } }] });
    const { body } = await check();
    expect(body).toMatchObject({ ok: true, status: 200, model: "gpt-test-mini" });
    expect(typeof body.latencyMs).toBe("number");
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-test-mini", max_tokens: 1 });
  });

  it("maps provider failures to plain hints and never echoes the endpoint or error body", async () => {
    withKey();
    process.env.LLM_BASE_URL = "https://llm.internal.example/v1";
    const cases: [number, RegExp][] = [[401, /rejected the API key/], [403, /permissions/], [404, /gpt-test-mini/], [429, /quota/], [503, /server error/]];
    for (const [status, hint] of cases) {
      provider(status, { error: { message: "secret-provider-detail sk-live-123" } });
      const { body } = await check();
      expect(body).toMatchObject({ ok: false, status });
      expect(body.hint).toMatch(hint);
      expect(JSON.stringify(body)).not.toMatch(/secret-provider-detail|sk-live|internal\.example|test-key/);
    }
  });

  it("reports network failures and timeouts", async () => {
    withKey();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await check()).body.hint).toMatch(/couldn't reach/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    expect((await check()).body.hint).toMatch(/didn't answer within 15 seconds/);
  });

  it("flags an endpoint that doesn't speak the chat API", async () => {
    withKey();
    provider(200, { hello: "world" });
    expect((await check()).body).toMatchObject({ ok: false, status: 200 });
  });

  it("allows 6 checks per IP every 10 minutes", async () => {
    provider(200);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await check({ "x-forwarded-for": "10.9.9.9" })).res.status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});

describe("Models settings page", () => {
  it("shows the model for every job with a key, and the fallback without one", () => {
    expect(jobRows({ llm: true, model: "gpt-4.1-mini" }).every((j) => j.ai && j.engine === "gpt-4.1-mini")).toBe(true);
    const off = jobRows({ llm: false, model: "gpt-4.1-mini" });
    expect(off.map((j) => j.engine)).toEqual(["Rules-based coach", "Rules-based grader", "Template wizard", "Scripted caller"]);
    expect(jobRows(null).every((j) => !j.ai)).toBe(true);
  });

  it("lists every voice engine in the server's order, available first", () => {
    const ids = (caps: Record<string, unknown> | null) => voiceEngines(caps).map((v) => [v.id, v.available, v.preferred]);
    // The shape getCapabilities() returns today.
    expect(ids({ realtime: true, elevenlabs: true, voiceEngines: ["elevenlabs", "openai"] })).toEqual([["elevenlabs", true, true], ["realtime", true, false]]);
    expect(voiceEngines({ realtime: true, voiceEngines: ["openai"], realtimeModel: "gpt-realtime" })[0]).toMatchObject({ id: "realtime", label: "OpenAI Realtime", model: "gpt-realtime" });
    expect(ids({ elevenlabs: false, realtime: false, voiceEngines: [] })).toEqual([["realtime", false, false], ["elevenlabs", false, false]]);
    // Older payloads without the list fall back to the flags.
    expect(ids({ elevenlabs: true })).toEqual([["elevenlabs", true, true], ["realtime", false, false]]);
    expect(ids(null)).toEqual([["realtime", false, false], ["elevenlabs", false, false]]);
    expect(voiceEngines({ realtime: "gpt-realtime-mini" })[0]).toMatchObject({ id: "realtime", model: "gpt-realtime-mini", available: true });
  });

  it("tolerates oddly shaped voice engine lists", () => {
    const ids = (caps: Record<string, unknown>) => voiceEngines(caps).map((v) => [v.id, v.available]);
    expect(ids({ voiceEngines: [{ id: "openai-realtime", model: "gpt-realtime", configured: false }, { id: "elevenlabs" }, "elevenlabs"] })).toEqual([["elevenlabs", true], ["realtime", false]]);
    expect(ids({ voiceEngines: { elevenlabs: false, openai: true } })).toEqual([["realtime", true], ["elevenlabs", false]]);
    expect(ids({ elevenlabs: true, voiceEngines: [null, 3, {}] })).toEqual([["elevenlabs", true], ["realtime", false]]);
    expect(ids({ voiceEngines: ["acme-voice"] })).toEqual([["acme-voice", true], ["realtime", false], ["elevenlabs", false]]);
  });
});

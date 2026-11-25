import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAST_VOICES, liveCastFits } from "@/lib/liveCasting";
import {
  PERSONA_JSON_SCHEMA,
  PERSONA_TOOL_NAME,
  castLiveVoice,
  castRealtimeVoice,
  generatePersona,
  llmPrompt,
  namingRule,
  templatePersona,
} from "@/lib/personaWizard";
import { REALTIME_VOICES } from "@/lib/realtime";
import { ScenarioSchema } from "@/lib/scenarios";
import { anthropicKey, getCapabilities, wizardFallbackModel, wizardModel, wizardOpenAiKey, wizardProvider } from "@/lib/serverConfig";
import { WizardInputSchema, type WizardInput } from "@/lib/wizard-types";

/**
 * The persona wizard's builder: the dedicated Anthropic path (forced tool use), the OpenAI strict json_schema path,
 * the fallback from Anthropic to the chat provider and then to the template, GPT-Live casting and keepRealNames.
 * No network: fetch is stubbed, and every provider env var is cleared before each test.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_KEY = "sk-ant-test-0000";
const CHAT_KEY = "k-chat-test";

const CLEAR = [
  "DEMO_MODE", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_MODEL_GRADING", "OPENAI_API_KEY", "OPENAI_API_KEY_BACKUP_1", "OPENAI_API_KEY_BACKUP_2",
  "ANTHROPIC_API_KEY", "WIZARD_API_KEY", "WIZARD_PROVIDER", "WIZARD_MODEL",
];
const stubEnv = (env: Record<string, string> = {}) => {
  for (const k of CLEAR) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
};

const FREIGHT: WizardInput = {
  role: "sdr",
  industry: "Freight brokerage",
  callType: "cold",
  difficulty: "hard",
  product: "Ridgeline Load Match: load-matching and carrier vetting for mid-size brokerages, $1,200 a month.",
  contexts: [
    { kind: "icp", text: "VP of Operations at freight brokerages with 50-300 employees. They fight thin margins and lose hours to manual load matching." },
    { kind: "url", text: "[Page Summary]\nPage: Ridgeline Load Match\nAbout: Match loads to vetted carriers in seconds." },
  ],
};

/** A complete model reply. Casting fields are deliberately wrong in places so post-validation shows. */
const modelScenario = (persona: Record<string, unknown> = {}) => ({
  title: "Cold call: VP of Operations at Tidewater Freight",
  industry: "Freight brokerage",
  durationMin: 6,
  callScript: "1. Greet them and give a one-line reason.\n2. Ask permission for two minutes.\n3. Ask how they match loads today.\n4. Tie Ridgeline Load Match to the pain.\n5. Book a 20-minute demo.",
  aiPersona: {
    name: "Dana Whitfield",
    role: "VP of Operations at Tidewater Freight, a 120-person brokerage",
    behavior: "You run operations at Tidewater Freight and you're between carrier calls. You only mention the double-brokering scare if asked how carriers are vetted.",
    openingLine: "Dana speaking. I've got two minutes, what's this about?",
    gender: "male",
    age: 48,
    emotion: "Guarded, and a bit hurried",
    liveVoice: "gleam",
    realtimeVoice: "shimmer",
    liveDelivery: "Brisk and clipped with a firm, mature voice; softens when the rep is specific.",
    liveBackchannel: 'Terse "uh-huh" or "right" only.',
    liveInterruption: "Cuts in on long monologues or buzzwords and pushes back.",
    ...persona,
  },
  traineeGoal: "Book a 20-minute demo with a specific day and time.",
  rubric: [
    { id: "opening", name: "Opening", description: "Clear reason for calling.", weight: 30 },
    { id: "discovery", name: "Discovery", description: "Asks how loads are matched today.", weight: 40 },
    { id: "next", name: "Next step", description: "Books a dated meeting.", weight: 30 },
  ],
  objections: [{ type: "timing", line: "I'm slammed, just email me.", prepAnswer: "Happy to. What should it cover?" }],
  sampleReplies: ["Dana Whitfield, 555-0137.", "What does it cost?", "Thursday works for my schedule.", "But the budget is tight.", "Sounds good, thanks."],
  sources: [
    { path: "aiPersona.role", kind: "icp", snippet: "VP of Operations at freight brokerages" },
    { path: "title", kind: "model", snippet: "" },
    { path: "__proto__", kind: "model", snippet: "" },
  ],
});

const anthropicReply = (input: unknown, stop_reason = "tool_use") =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", stop_reason, content: [{ type: "text", text: "Here it is." }, { type: "tool_use", id: "toolu_1", name: PERSONA_TOOL_NAME, input }] });
const openAiReply = (obj: unknown, finish_reason = "stop") => Response.json({ id: "chatcmpl-1", choices: [{ message: { content: JSON.stringify(obj) }, finish_reason }] });

type Call = { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> };
/** Stubs fetch with a router; records every call with its parsed body and headers. */
function stubFetch(route: (url: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const call = { url: String(url), init, body, headers: init.headers as Record<string, string> };
    calls.push(call);
    return route(call.url, body);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stubEnv();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wizard provider config (server-only)", () => {
  it.each<[string, Record<string, string>, ReturnType<typeof wizardProvider>]>([
    ["no keys", {}, "none"],
    ["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "sk-ant-a" }, "anthropic"],
    ["an sk-ant- WIZARD_API_KEY", { WIZARD_API_KEY: "sk-ant-w" }, "anthropic"],
    ["WIZARD_PROVIDER=anthropic with any WIZARD_API_KEY", { WIZARD_PROVIDER: "anthropic", WIZARD_API_KEY: "proxy-key" }, "anthropic"],
    ["a non-Anthropic WIZARD_API_KEY", { WIZARD_API_KEY: "sk-proj-w" }, "openai"],
    ["only the chat key", { LLM_API_KEY: "k" }, "openai"],
    ["Anthropic beats the chat key when unset", { ANTHROPIC_API_KEY: "sk-ant-a", LLM_API_KEY: "k" }, "anthropic"],
    ["WIZARD_PROVIDER=OpenAI (any case) forces the chat key", { WIZARD_PROVIDER: " OpenAI ", ANTHROPIC_API_KEY: "sk-ant-a", LLM_API_KEY: "k" }, "openai"],
    ["WIZARD_PROVIDER=openai with only an Anthropic key", { WIZARD_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-a" }, "none"],
    ["WIZARD_PROVIDER=openai with an sk-ant- WIZARD_API_KEY", { WIZARD_PROVIDER: "openai", WIZARD_API_KEY: "sk-ant-x" }, "none"],
  ])("%s -> %s", (_label, env, want) => {
    expect(wizardProvider(env)).toBe(want);
  });

  it("picks the Anthropic key and never treats it as an OpenAI key", () => {
    expect(anthropicKey({ WIZARD_API_KEY: "sk-ant-w", ANTHROPIC_API_KEY: "sk-ant-a" })).toBe("sk-ant-w");
    expect(anthropicKey({ WIZARD_API_KEY: "sk-proj-w", ANTHROPIC_API_KEY: "sk-ant-a" })).toBe("sk-ant-a");
    expect(anthropicKey({ WIZARD_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-ant-a" })).toBeUndefined();
    expect(wizardOpenAiKey({ WIZARD_API_KEY: "sk-ant-w" })).toBeUndefined();
    expect(wizardOpenAiKey({ WIZARD_PROVIDER: "openai", WIZARD_API_KEY: "sk-ant-w" })).toBeUndefined();
    expect(wizardOpenAiKey({ WIZARD_PROVIDER: "anthropic", WIZARD_API_KEY: "proxy-key" })).toBeUndefined();
    expect(wizardOpenAiKey({ WIZARD_API_KEY: "sk-proj-w" })).toBe("sk-proj-w");
  });

  it("defaults the model per provider and honors WIZARD_MODEL", () => {
    expect(wizardModel({ ANTHROPIC_API_KEY: "sk-ant-a" })).toBe("claude-opus-5-5");
    expect(wizardModel({ ANTHROPIC_API_KEY: "sk-ant-a", WIZARD_MODEL: " custom-builder " })).toBe("custom-builder");
    // OpenAI host always defaults to gpt-6-astra (never gpt-6-luna), even when LLM_MODEL or LLM_MODEL_GRADING is set.
    expect(wizardModel({ LLM_API_KEY: "k", LLM_MODEL: "gpt-6-luna", LLM_MODEL_GRADING: "grader-x" })).toBe("gpt-6-astra");
    expect(wizardModel({ LLM_API_KEY: "k", LLM_MODEL: "chat-x" })).toBe("gpt-6-astra");
    expect(wizardModel({ LLM_API_KEY: "k", WIZARD_MODEL: "custom-openai" })).toBe("custom-openai");
    expect(wizardModel({})).toBe("gpt-6-astra");
    // Custom non-OpenAI hosts keep their configured grading/chat model.
    expect(wizardModel({ LLM_API_KEY: "k", LLM_BASE_URL: "https://llm.internal.example/v1", LLM_MODEL_GRADING: "grader-x" })).toBe("grader-x");
    expect(wizardFallbackModel({ LLM_MODEL_GRADING: "grader-x", WIZARD_MODEL: "custom-builder" })).toBe("gpt-6-astra");
    expect(wizardFallbackModel({ LLM_BASE_URL: "https://llm.internal.example/v1", LLM_MODEL_GRADING: "grader-x" })).toBe("grader-x");
  });

  it("reads process.env by default, defaulting to gpt-6-astra on OpenAI", () => {
    stubEnv({ LLM_API_KEY: CHAT_KEY, LLM_MODEL: "gpt-6-luna" });
    expect(wizardProvider()).toBe("openai");
    expect(wizardModel()).toBe("gpt-6-astra");
  });

  it("adds nothing to the public capabilities", () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, WIZARD_MODEL: "custom-builder" });
    const caps = JSON.stringify(getCapabilities());
    expect(Object.keys(getCapabilities()).sort()).toEqual(["billing", "database", "demoMode", "elevenlabs", "hosted", "llm", "premiumOnSale", "provider", "realtime", "voiceEngines"]);
    expect(caps).not.toMatch(/sk-ant|custom-builder|claude|wizard/i);
  });
});

describe("strict persona JSON schema", () => {
  /** Every object node: additionalProperties false and every property required (OpenAI strict mode). */
  const objects = (node: unknown, path = "$"): [string, Record<string, unknown>][] => {
    if (!node || typeof node !== "object") return [];
    const n = node as Record<string, unknown>;
    const own: [string, Record<string, unknown>][] = n.type === "object" ? [[path, n]] : [];
    const kids = [
      ...Object.entries((n.properties as Record<string, unknown>) ?? {}).map(([k, v]) => objects(v, `${path}.${k}`)),
      objects(n.items, `${path}[]`),
      ...((n.anyOf as unknown[]) ?? []).map((v, i) => objects(v, `${path}|${i}`)),
    ];
    return [...own, ...kids.flat()];
  };

  it("is strict on every object", () => {
    const all = objects(PERSONA_JSON_SCHEMA);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const [path, o] of all) {
      expect(o.additionalProperties, path).toBe(false);
      expect([...(o.required as string[])].sort(), path).toEqual(Object.keys(o.properties as object).sort());
    }
  });

  it("enumerates the cast voices, the Realtime voices and nullable gender and age", () => {
    const p = (PERSONA_JSON_SCHEMA.properties.aiPersona as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(p.liveVoice.enum).toEqual([...LIVE_CAST_VOICES]);
    expect(p.realtimeVoice.enum).toEqual([...REALTIME_VOICES]);
    expect(p.gender.anyOf).toEqual([{ type: "string", enum: ["female", "male"] }, { type: "null" }]);
    expect(p.age.anyOf).toEqual([{ type: "integer" }, { type: "null" }]);
    expect(PERSONA_TOOL_NAME).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("Anthropic builder (forced tool use)", () => {
  it("calls the pinned Messages URL with the tool schema and casts the reply", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const calls = stubFetch(() => anthropicReply(modelScenario()));
    const out = await generatePersona(FREIGHT);

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(ANTHROPIC_URL);
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("error");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(c.headers).toEqual({ "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(c.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      temperature: 0.6,
      tool_choice: { type: "tool", name: PERSONA_TOOL_NAME },
      messages: [{ role: "user", content: expect.stringContaining("CHIPS") }],
    });
    const tools = c.body.tools as { name: string; description: string; input_schema: unknown }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: PERSONA_TOOL_NAME, input_schema: PERSONA_JSON_SCHEMA });
    expect(String(c.body.system)).toContain("KEEP the user's real company name");
    expect(String(c.body.system)).toContain("full-duplex");

    expect(out.method).toBe("llm");
    const s = out.scenario;
    expect(ScenarioSchema.safeParse(s).success).toBe(true);
    expect(s.rubric.reduce((a, r) => a + r.weight, 0)).toBe(100);
    // A male persona never keeps a female voice: gleam -> meridian, shimmer -> cedar.
    expect(s.aiPersona).toMatchObject({ gender: "male", age: 48, emotion: "guarded", liveVoice: "meridian", realtimeVoice: "cedar" });
    expect(liveCastFits(s.aiPersona.liveVoice, s.aiPersona.gender)).toBe(true);
    expect(s.aiPersona.liveBackchannel).toBe('Terse "uh-huh" or "right" only.');
    expect(s.aiPersona.liveInterruption).toMatch(/Cuts in/);
    expect(out.sources["aiPersona.role"]).toEqual({ kind: "icp", snippet: "VP of Operations at freight brokerages" });
    expect(out.sources.title).toEqual({ kind: "model", snippet: "" });
    expect(Object.keys(out.sources)).not.toContain("__proto__");
    // Nothing returned names the model or the key.
    expect(JSON.stringify(out)).not.toMatch(/claude|sk-ant/);
    expect(out).not.toHaveProperty("model");
  });

  it("anonymizes when keepRealNames is false, keeps real names by default", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const calls = stubFetch(() => anthropicReply(modelScenario()));
    await generatePersona({ ...FREIGHT, keepRealNames: false });
    await generatePersona(FREIGHT);
    const [anon, real] = calls.map((c) => String(c.body.system));
    expect(anon).toContain("Anonymize all real names");
    expect(anon).not.toContain("KEEP the user's real");
    expect(real).toContain("KEEP the user's real company name, product name, pricing, and domain details");
    expect(real).not.toContain("Anonymize all real names");
  });

  it("defaults keepRealNames to true when a caller leaves it out", () => {
    const parsed = WizardInputSchema.parse({ ...FREIGHT });
    expect(parsed.keepRealNames).toBe(true);
    expect(WizardInputSchema.parse({ ...FREIGHT, keepRealNames: false }).keepRealNames).toBe(false);
    expect(WizardInputSchema.safeParse({ ...FREIGHT, keepRealNames: "yes" }).success).toBe(false);
    expect(namingRule(undefined)).toBe(namingRule(true));
  });

  it("asks for live-voice writing: spoken opening, second-person behavior, hidden facts, calibrated policies", () => {
    const { system, user } = llmPrompt(FREIGHT, null);
    for (const want of [
      "openingLine", "contractions", "5-8 sharp sentences", "hidden facts", "1-3 short spoken sentences", "liveDelivery", "liveBackchannel", "liveInterruption",
      "pushes back", "dodge a price question", "waits patiently",
    ]) expect(system, want).toContain(want);
    expect(user).toContain("Ridgeline Load Match");
    expect(llmPrompt(FREIGHT, "insurance").system).toContain("regulated field");
  });

  it("retries once without temperature when the model rejects it", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    let n = 0;
    const calls = stubFetch(() =>
      n++ === 0
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "temperature is not supported" } }, { status: 400 })
        : anthropicReply(modelScenario()),
    );
    const out = await generatePersona(FREIGHT);
    expect(out.method).toBe("llm");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveProperty("temperature", 0.6);
    expect(calls[1].body).not.toHaveProperty("temperature");
  });

  it("falls back to the chat provider on an Anthropic HTTP error, without sending the Anthropic key", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, LLM_API_KEY: CHAT_KEY, LLM_MODEL_GRADING: "grader-x" });
    const calls = stubFetch((url) =>
      url === ANTHROPIC_URL ? Response.json({ type: "error", error: { type: "overloaded_error", message: `key ${ANTHROPIC_KEY}` } }, { status: 529 }) : openAiReply(modelScenario()),
    );
    const out = await generatePersona(FREIGHT);
    expect(calls.map((c) => c.url)).toEqual([ANTHROPIC_URL, OPENAI_URL]);
    expect(out.method).toBe("llm");
    const chat = calls[1];
    expect(chat.headers.Authorization).toBe(`Bearer ${CHAT_KEY}`);
    expect(JSON.stringify(chat.init)).not.toContain("sk-ant");
    // The chat provider on OpenAI gets the OpenAI wizard default (gpt-6-astra), never the Anthropic default or gpt-6-luna.
    expect(chat.body.model).toBe("gpt-6-astra");
    expect(chat.body.reasoning_effort).toBe("medium");
    // Logs: provider and status only, never the key or the provider's body.
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("529");
    expect(logged).not.toMatch(/sk-ant|overloaded_error|gpt-6-astra|claude/);
  });

  it("falls back to the chat provider on a network failure", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY, LLM_API_KEY: CHAT_KEY });
    const calls = stubFetch((url) => {
      if (url === ANTHROPIC_URL) throw new TypeError(`fetch failed for ${url}`);
      return openAiReply(modelScenario());
    });
    const out = await generatePersona(FREIGHT);
    expect(out.method).toBe("llm");
    expect(calls.map((c) => c.url)).toEqual([ANTHROPIC_URL, OPENAI_URL]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("fetch failed");
  });

  it.each([
    ["an HTTP error", () => new Response("{}", { status: 500 })],
    ["a truncated reply", () => anthropicReply(modelScenario(), "max_tokens")],
    ["a reply with no tool_use block", () => Response.json({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" })],
    ["a tool input that fails the shape", () => anthropicReply({ title: "x" })],
  ])("uses the template on %s when no chat key is configured", async (_label, reply) => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const calls = stubFetch(reply);
    const out = await generatePersona(FREIGHT);
    expect(calls).toHaveLength(1);
    expect(out.method).toBe("template");
    expect(ScenarioSchema.safeParse(out.scenario).success).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/sk-ant|"title":"x"/);
  });
});

describe("OpenAI builder (strict json_schema)", () => {
  it("sends strict structured outputs, medium reasoning and gpt-6-astra through chatFull", async () => {
    stubEnv({ LLM_API_KEY: CHAT_KEY, LLM_MODEL: "gpt-6-luna" });
    const calls = stubFetch(() => openAiReply(modelScenario({ gender: "female", liveVoice: "cedar", realtimeVoice: "ash", age: 15 })));
    const out = await generatePersona(FREIGHT);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(OPENAI_URL);
    expect(c.headers.Authorization).toBe(`Bearer ${CHAT_KEY}`);
    expect(c.body).toMatchObject({
      model: "gpt-6-astra",
      temperature: 0.6,
      max_completion_tokens: 6144,
      reasoning_effort: "medium",
      response_format: { type: "json_schema", json_schema: { name: PERSONA_TOOL_NAME, strict: true, schema: PERSONA_JSON_SCHEMA } },
    });
    expect((c.body.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user"]);
    expect(out.method).toBe("llm");
    // A female persona never keeps a male voice; an age outside 22-72 is dropped.
    expect(out.scenario.aiPersona).toMatchObject({ gender: "female", liveVoice: "gleam", realtimeVoice: "marin" });
    expect(out.scenario.aiPersona.age).toBeUndefined();
  });

  it("sends a dedicated WIZARD_API_KEY only to the OpenAI host, even with a custom chat base", async () => {
    stubEnv({ WIZARD_API_KEY: "sk-proj-wizard", LLM_API_KEY: CHAT_KEY, LLM_BASE_URL: "https://llm.internal.example/v1" });
    const calls = stubFetch(() => openAiReply(modelScenario()));
    const out = await generatePersona(FREIGHT);
    expect(out.method).toBe("llm");
    expect(calls.map((c) => c.url)).toEqual([OPENAI_URL]);
    expect(calls[0].headers.Authorization).toBe("Bearer sk-proj-wizard");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].body).toMatchObject({ response_format: { type: "json_schema", json_schema: { strict: true, name: PERSONA_TOOL_NAME } }, reasoning_effort: "medium" });
  });

  it("uses the template when the chat reply is truncated", async () => {
    stubEnv({ LLM_API_KEY: CHAT_KEY });
    stubFetch(() => openAiReply(modelScenario(), "length"));
    expect((await generatePersona(FREIGHT)).method).toBe("template");
  });
});

describe("GPT-Live casting", () => {
  it("keeps a voice that fits and replaces one that doesn't", () => {
    expect(castLiveVoice("male", "Cedar")).toBe("cedar");
    expect(castLiveVoice("male", "vesper")).toBe("vesper");
    expect(castLiveVoice("male", "gleam")).toBe("meridian");
    expect(castLiveVoice("female", "willow")).toBe("willow");
    expect(castLiveVoice("female", "marin")).toBe("marin");
    expect(castLiveVoice("female", "stone")).toBe("gleam");
    expect(castLiveVoice(undefined, "gleam")).toBe("marin");
    expect(castLiveVoice(undefined, "not-a-voice")).toBe("marin");
    expect(castLiveVoice("male", null)).toBe("meridian");
    expect(castRealtimeVoice("male", "ash")).toBe("ash");
    expect(castRealtimeVoice("male", "coral")).toBe("cedar");
    expect(castRealtimeVoice("female", "coral")).toBe("coral");
    expect(castRealtimeVoice("female", "echo")).toBe("marin");
    expect(castRealtimeVoice(undefined, "alloy")).toBe("alloy");
    expect(castRealtimeVoice(undefined, "verse")).toBe("marin");
  });

  it("always lands on a voice that fits, for every voice and gender", () => {
    for (const g of ["female", "male", undefined] as const) {
      for (const v of [...LIVE_CAST_VOICES, "bogus", undefined]) expect(liveCastFits(castLiveVoice(g, v), g), `${g} ${v}`).toBe(true);
    }
  });

  it("treats a null gender as unspecified and fills missing casting from the difficulty", async () => {
    stubEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    stubFetch(() =>
      anthropicReply(modelScenario({ gender: null, age: null, liveVoice: "gleam", emotion: "", liveDelivery: "x".repeat(900), liveBackchannel: null, liveInterruption: "" })),
    );
    const p = (await generatePersona(FREIGHT)).scenario.aiPersona;
    expect(p.gender).toBeUndefined();
    expect(p.age).toBeUndefined();
    expect(p.liveVoice).toBe("marin");
    expect(p.emotion).toBe("hurried");
    expect(p.liveDelivery!.length).toBeLessThanOrEqual(400);
    expect(p.liveBackchannel).toMatch(/uh-huh/);
    expect(p.liveInterruption).toMatch(/Cut in/);
  });

  it.each(["easy", "medium", "hard"] as const)("gives %s template drafts a complete live cast", (difficulty) => {
    for (const callType of ["cold", "inbound", "collections", "service"] as const) {
      const s = templatePersona({ ...FREIGHT, difficulty, callType }).scenario;
      expect(ScenarioSchema.safeParse(s).success).toBe(true);
      const p = s.aiPersona;
      expect(p.gender).toBeUndefined();
      expect(p.liveVoice).toBe("marin");
      expect(p.realtimeVoice).toBe("marin");
      expect(liveCastFits(p.liveVoice, p.gender)).toBe(true);
      expect(p.emotion!.length).toBeGreaterThan(0);
      expect(p.emotion!.length).toBeLessThanOrEqual(20);
      expect(p.liveDelivery!.length).toBeLessThanOrEqual(400);
      expect(p.liveBackchannel!.length).toBeLessThanOrEqual(300);
      expect(p.liveInterruption!.length).toBeLessThanOrEqual(300);
    }
    const easy = templatePersona({ ...FREIGHT, difficulty: "easy" }).scenario.aiPersona;
    const hard = templatePersona({ ...FREIGHT, difficulty: "hard" }).scenario.aiPersona;
    expect(easy.liveInterruption).toMatch(/patiently/);
    expect(hard.liveInterruption).toMatch(/Cut in/);
    expect(easy.liveBackchannel).toMatch(/mm-hm/);
    expect(hard.liveBackchannel).toMatch(/uh-huh/);
  });
});

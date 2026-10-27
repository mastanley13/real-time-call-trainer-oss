import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, TurnAssembler, applyRealtimeEvent, averageLevel, chooseVoiceEngine,
  micErrorMessage, openingInstructions, orderVoiceEngines, pickRealtimeVoice, realtimeModel, realtimeUpstreamMessage, resolveRealtimeKey,
} from "@/lib/realtime";
import { getCapabilities } from "@/lib/serverConfig";
import { BUILT_IN_SCENARIOS, buildAgentPrompt } from "@/lib/scenarios";
import { NextRequest } from "next/server";
import { POST as sessionPOST } from "@/app/api/realtime/session/route";
import { POST as sdpPOST } from "@/app/api/realtime/sdp/route";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("resolveRealtimeKey", () => {
  it("prefers the dedicated realtime key, then OPENAI_API_KEY", () => {
    expect(resolveRealtimeKey({ OPENAI_REALTIME_API_KEY: "rt", OPENAI_API_KEY: "oa", LLM_API_KEY: "llm" })).toBe("rt");
    expect(resolveRealtimeKey({ OPENAI_API_KEY: "oa", LLM_API_KEY: "llm" })).toBe("oa");
  });
  it("uses LLM_API_KEY only when the LLM base URL is OpenAI", () => {
    expect(resolveRealtimeKey({ LLM_API_KEY: "llm" })).toBe("llm");
    expect(resolveRealtimeKey({ LLM_API_KEY: "llm", LLM_BASE_URL: "https://api.openai.com/v1" })).toBe("llm");
    expect(resolveRealtimeKey({ LLM_API_KEY: "llm", LLM_BASE_URL: "https://openrouter.ai/api/v1" })).toBeUndefined();
    expect(resolveRealtimeKey({ LLM_API_KEY: "llm", LLM_BASE_URL: "http://localhost:11434/v1" })).toBeUndefined();
  });
  it("treats blank values as missing", () => {
    expect(resolveRealtimeKey({ OPENAI_REALTIME_API_KEY: "  ", OPENAI_API_KEY: "" })).toBeUndefined();
    expect(resolveRealtimeKey({})).toBeUndefined();
  });
});

describe("model and voice", () => {
  it("defaults the model and honours REALTIME_MODEL", () => {
    vi.stubEnv("REALTIME_MODEL", "");
    expect(realtimeModel()).toBe(DEFAULT_REALTIME_MODEL);
    vi.stubEnv("REALTIME_MODEL", "gpt-realtime-2.1");
    expect(realtimeModel()).toBe("gpt-realtime-2.1");
  });
  it("picks persona voice, then env voice, then the default, ignoring unknown names", () => {
    expect(pickRealtimeVoice("Cedar", "ash")).toBe("cedar");
    expect(pickRealtimeVoice(undefined, "ash")).toBe("ash");
    expect(pickRealtimeVoice("not-a-voice", "also-not")).toBe(DEFAULT_REALTIME_VOICE);
    expect(pickRealtimeVoice(undefined, undefined)).toBe("marin");
  });
});

describe("engine selection", () => {
  it("puts OpenAI first unless VOICE_ENGINE asks for ElevenLabs", () => {
    expect(orderVoiceEngines({ openai: true, elevenlabs: true })).toEqual(["openai", "elevenlabs"]);
    expect(orderVoiceEngines({ openai: true, elevenlabs: true }, "ElevenLabs")).toEqual(["elevenlabs", "openai"]);
    expect(orderVoiceEngines({ openai: true, elevenlabs: false }, "elevenlabs")).toEqual(["openai"]);
    expect(orderVoiceEngines({ openai: false, elevenlabs: true })).toEqual(["elevenlabs"]);
    expect(orderVoiceEngines({ openai: false, elevenlabs: false })).toEqual([]);
  });
  it("keeps a saved pick only while the server still offers it", () => {
    expect(chooseVoiceEngine(["openai", "elevenlabs"], "elevenlabs")).toBe("elevenlabs");
    expect(chooseVoiceEngine(["openai"], "elevenlabs")).toBe("openai");
    expect(chooseVoiceEngine(["openai", "elevenlabs"], null)).toBe("openai");
    expect(chooseVoiceEngine([], "openai")).toBeNull();
    expect(chooseVoiceEngine(undefined)).toBeNull();
  });
  it("reports realtime capabilities from env", () => {
    vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ELEVENLABS_API_KEY", "el");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent");
    vi.stubEnv("VOICE_ENGINE", "");
    const caps = getCapabilities();
    expect(caps.realtime).toBe(true);
    expect(caps.voiceEngines).toEqual(["openai", "elevenlabs"]);
    expect(JSON.stringify(caps)).not.toContain("sk-test");

    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "");
    const none = getCapabilities();
    expect(none.realtime).toBe(false);
    expect(none.voiceEngines).toEqual(["elevenlabs"]);
  });
});

describe("TurnAssembler", () => {
  it("orders a late user transcription before the persona reply that followed it", () => {
    const asm = new TurnAssembler();
    const seen: string[] = [];
    const feed = (ev: Parameters<typeof applyRealtimeEvent>[1], t = 0) => {
      applyRealtimeEvent(asm, ev, t);
      seen.push(...asm.flush(t).map((x) => `${x.role}:${x.text}`));
    };
    // Opening line from the persona
    feed({ type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } });
    feed({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Hi, my heater is leaking." });
    // Trainee speaks; the reply is generated before the trainee's transcription lands
    feed({ type: "input_audio_buffer.committed", item_id: "u1", previous_item_id: "a1" }, 100);
    feed({ type: "conversation.item.added", previous_item_id: "a1", item: { id: "u1", type: "message", role: "user" } }, 100);
    feed({ type: "response.output_item.added", item: { id: "a2", type: "message", role: "assistant" } }, 200);
    feed({ type: "response.output_audio_transcript.done", item_id: "a2", transcript: "Great, thanks." }, 300);
    expect(seen).toEqual(["assistant:Hi, my heater is leaking."]);
    feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: " Can I get your address? " }, 400);
    expect(seen).toEqual(["assistant:Hi, my heater is leaking.", "user:Can I get your address?", "assistant:Great, thanks."]);
  });

  it("drops failed or empty transcriptions without blocking later turns", () => {
    const asm = new TurnAssembler();
    applyRealtimeEvent(asm, { type: "input_audio_buffer.committed", item_id: "u1" }, 0);
    applyRealtimeEvent(asm, { type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } }, 0);
    applyRealtimeEvent(asm, { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Sorry, say that again?" }, 0);
    expect(asm.flush(0)).toEqual([]);
    applyRealtimeEvent(asm, { type: "conversation.item.input_audio_transcription.failed", item_id: "u1" }, 0);
    expect(asm.flush(0)).toEqual([{ role: "assistant", text: "Sorry, say that again?" }]);
    expect(asm.pending).toBe(0);
  });

  it("skips a transcription stuck past the wait limit, then releases it if it arrives late", () => {
    const asm = new TurnAssembler(1000);
    asm.note("u1", "user", null, 0);
    asm.finalize("a1", "assistant", "Hello?", 10);
    expect(asm.flush(500)).toEqual([]);
    expect(asm.flush(1500)).toEqual([{ role: "assistant", text: "Hello?" }]);
    asm.finalize("u1", "user", "Sorry, I was muted.", 2000);
    expect(asm.flush(2000)).toEqual([{ role: "user", text: "Sorry, I was muted." }]);
  });

  it("force-flushes what is final on hang-up and never emits a turn twice", () => {
    const asm = new TurnAssembler();
    asm.note("u1", "user", null, 0);
    asm.finalize("a1", "assistant", "Anything else?", 0);
    expect(asm.flush(0, true)).toEqual([{ role: "assistant", text: "Anything else?" }]);
    asm.finalize("a1", "assistant", "Anything else?", 0);
    expect(asm.flush(0, true)).toEqual([]);
  });

  it("settles an interrupted reply from response.done but never overwrites a real transcript", () => {
    const asm = new TurnAssembler();
    applyRealtimeEvent(asm, { type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } });
    applyRealtimeEvent(asm, { type: "response.done", response: { status: "cancelled", output: [{ id: "a1", type: "message", role: "assistant", content: [{ transcript: "Well, the thing" }] }] } });
    expect(asm.flush()).toEqual([{ role: "assistant", text: "Well, the thing" }]);

    applyRealtimeEvent(asm, { type: "response.output_audio_transcript.done", item_id: "a2", transcript: "Full reply." });
    applyRealtimeEvent(asm, { type: "response.done", response: { output: [{ id: "a2", type: "message", role: "assistant", content: [] }] } });
    expect(asm.flush()).toEqual([{ role: "assistant", text: "Full reply." }]);
  });

  it("accepts the beta transcript event name and ignores unrelated events", () => {
    const asm = new TurnAssembler();
    expect(applyRealtimeEvent(asm, { type: "response.audio_transcript.done", item_id: "a1", transcript: "Hi." })).toBe(true);
    expect(applyRealtimeEvent(asm, { type: "response.output_audio.delta" })).toBe(false);
    expect(applyRealtimeEvent(asm, { type: "conversation.item.added", item: { id: "f1", type: "function_call" } })).toBe(false);
    expect(asm.flush()).toEqual([{ role: "assistant", text: "Hi." }]);
  });
});

describe("small helpers", () => {
  it("quotes the opening line verbatim", () => {
    const s = openingInstructions("Dana Whitfield", "  Hi, can someone come out today?  ");
    expect(s).toContain("Dana Whitfield");
    expect(s).toContain('"Hi, can someone come out today?"');
  });
  it("averages analyser bins into 0..1", () => {
    expect(averageLevel([])).toBe(0);
    expect(averageLevel([255, 255])).toBe(1);
    expect(averageLevel([0, 255])).toBeCloseTo(0.5);
  });
  it("explains mic failures", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toMatch(/blocked/);
    expect(micErrorMessage({ name: "NotFoundError" })).toMatch(/No microphone/);
    expect(micErrorMessage(new Error("x"))).toMatch(/Could not open/);
  });
  it("maps upstream failures to friendly messages without echoing a body", () => {
    expect(realtimeUpstreamMessage(401, "m")).toBe("OpenAI rejected the API key. Check OPENAI_API_KEY.");
    expect(realtimeUpstreamMessage(400, "gpt-x")).toContain("gpt-x");
    expect(realtimeUpstreamMessage(503, "m")).toMatch(/Try again/);
  });
});

describe("POST /api/realtime/session", () => {
  const scenario = BUILT_IN_SCENARIOS[0];
  const req = (body: unknown) => new NextRequest("http://localhost/api/realtime/session", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body),
  });
  const setup = () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("REALTIME_MODEL", "");
    vi.stubEnv("REALTIME_VOICE", "");
  };
  afterEach(() => vi.unstubAllGlobals());

  it("returns 503 realtime_not_configured without a key", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "");
    const res = await sessionPOST(req({ scenario }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("realtime_not_configured");
  });

  it("mints a client secret with the persona prompt, transcription and VAD, and never returns the key", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-test");
    const fetchMock = vi.fn(async () => Response.json({ value: "ek_abc123456789", expires_at: 1_900_000_000 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sessionPOST(req({ scenario }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk-secret-test");
    expect(JSON.parse(text)).toEqual({ clientSecret: "ek_abc123456789", expiresAt: 1_900_000_000, model: DEFAULT_REALTIME_MODEL, voice: "marin" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-test");
    const sent = JSON.parse(init.body as string);
    expect(sent.session.type).toBe("realtime");
    expect(sent.session.instructions).toBe(buildAgentPrompt(scenario));
    expect(sent.session.audio.input.transcription.model).toBeTruthy();
    expect(sent.session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(sent.session.audio.output.voice).toBe("marin");
  });

  it("maps an upstream 401 to a friendly message without the upstream body", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "sk-bad");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"Incorrect API key provided: sk-bad"}}', { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sessionPOST(req({ scenario }));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: "realtime_upstream_error", message: "OpenAI rejected the API key. Check OPENAI_API_KEY." });
    expect(text).not.toContain("sk-bad");
  });

  it("rejects a malformed scenario", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "sk-x");
    const res = await sessionPOST(req({ scenario: { id: "x" } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/realtime/sdp", () => {
  const req = (body: unknown) => new NextRequest("http://localhost/api/realtime/sdp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  afterEach(() => vi.unstubAllGlobals());

  it("relays the offer with the client secret as documented", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const fetchMock = vi.fn(async () => new Response("v=0 answer", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sdpPOST(req({ clientSecret: "ek_abc123456789", sdp: "v=0 offer sdp" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sdp: "v=0 answer" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init.headers).toEqual({ Authorization: "Bearer ek_abc123456789", "Content-Type": "application/sdp" });
    expect(init.body).toBe("v=0 offer sdp");
  });

  it("refuses anything that is not an ephemeral secret", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sdpPOST(req({ clientSecret: "sk-project-key", sdp: "v=0 offer sdp" }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an expired secret", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sdpPOST(req({ clientSecret: "ek_abc123456789", sdp: "v=0 offer sdp" }));
    expect((await res.json()).error).toBe("realtime_secret_expired");
  });
});

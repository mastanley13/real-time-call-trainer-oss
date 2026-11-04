import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REALTIME_MODEL, DEFAULT_REALTIME_VOICE, TurnAssembler, applyRealtimeEvent, averageLevel, chooseVoiceEngine,
  micErrorMessage, openingInstructions, orderVoiceEngines, pickRealtimeVoice, realtimeModel, realtimeUpstreamMessage, resolveRealtimeKey,
} from "@/lib/realtime";
import { getCapabilities } from "@/lib/serverConfig";
import { BUILT_IN_SCENARIOS, buildAgentPrompt } from "@/lib/scenarios";
import { HARD_SESSION_CAP_SECONDS, PROVIDER_LIMIT_GRACE_SECONDS } from "@/lib/usagePlan";
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

  it("returns the model and voice only: no client secret, no key, no provider request", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sessionPOST(req({ scenario }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk-secret-test");
    expect(text).not.toContain("ek_");
    expect(JSON.parse(text)).toEqual({ model: DEFAULT_REALTIME_MODEL, voice: "marin" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed scenario", async () => {
    setup();
    vi.stubEnv("OPENAI_API_KEY", "sk-x");
    const res = await sessionPOST(req({ scenario: { id: "x" } }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/realtime/sdp", () => {
  // Metering off (demo mode): no call row. The metered flow is covered in realtime-hangup.test.ts.
  const scenario = BUILT_IN_SCENARIOS[0];
  const req = (body: unknown) => new NextRequest("http://localhost/api/realtime/sdp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const setup = () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("OPENAI_API_KEY", "sk-secret-test");
    vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
    vi.stubEnv("REALTIME_MODEL", "");
    vi.stubEnv("REALTIME_VOICE", "");
  };
  afterEach(() => vi.unstubAllGlobals());

  it("posts the offer and the persona session to the calls endpoint with the server key, and returns the answer", async () => {
    setup();
    const fetchMock = vi.fn(async () => new Response("v=0 answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_abc123" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sdpPOST(req({ sdp: "v=0 offer sdp", scenario }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ sdp: "v=0 answer" });
    expect(text).not.toContain("rtc_abc123");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-test");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("sdp")).toBe("v=0 offer sdp");
    const session = JSON.parse(form.get("session") as string);
    expect(session.type).toBe("realtime");
    expect(session.model).toBe(DEFAULT_REALTIME_MODEL);
    expect(session.instructions).toBe(buildAgentPrompt(scenario));
    expect(session.audio.input.transcription.model).toBeTruthy();
    expect(session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(session.audio.output.voice).toBe("marin");
  });

  it("refuses an offer that names a call when voice is not metered, and refuses the old clientSecret body", async () => {
    setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await sdpPOST(req({ callId: "c1", sdp: "v=0 offer sdp", scenario }))).status).toBe(400);
    expect((await sdpPOST(req({ clientSecret: "ek_abc123456789", sdp: "v=0 offer sdp" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream 401 to a friendly message without the upstream body", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"Incorrect API key provided: sk-secret-test"}}', { status: 401 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sdpPOST(req({ sdp: "v=0 offer sdp", scenario }));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: "realtime_upstream_error", message: "OpenAI rejected the API key. Check OPENAI_API_KEY." });
    expect(text).not.toContain("sk-secret-test");
  });

  it("fails a response with no call id instead of handing the browser a call the server cannot hang up", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("v=0 answer", { status: 201 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await sdpPOST(req({ sdp: "v=0 offer sdp", scenario }))).status).toBe(502);
  });

  it("with metering off, hangs the call up after the hard ceiling plus grace (best effort, in process)", async () => {
    setup();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const fetchMock = vi.fn(async () => new Response("v=0 answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_unmetered" } }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await sdpPOST(req({ sdp: "v=0 offer sdp", scenario }))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync((HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS) * 1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://api.openai.com/v1/realtime/calls/rtc_unmetered/hangup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("with metering off, carries the per-IP realtime limit itself: over it gets 429 and OpenAI is not called", async () => {
    setup();
    vi.stubEnv("RATE_LIMIT_REALTIME_MAX", "1");
    const fetchMock = vi.fn(async () => new Response("v=0 answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_ip" } }));
    vi.stubGlobal("fetch", fetchMock);
    const ip = { "x-forwarded-for": "10.9.9.9" };
    const post = () => sdpPOST(new NextRequest("http://localhost/api/realtime/sdp", { method: "POST", headers: { "content-type": "application/json", ...ip }, body: JSON.stringify({ sdp: "v=0 offer sdp", scenario }) }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      expect((await post()).status).toBe(200);
      expect((await post()).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

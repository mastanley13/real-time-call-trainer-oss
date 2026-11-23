import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  LiveTranscript, applyLiveEvent, buildLiveInstructions, liveSessionBody, openAiVoiceApi, pickLiveVoice,
} from "@/lib/live";
import { liveModel } from "@/lib/voiceModels";
import { openLiveTicket, resetLiveTickets, sealLiveTicket } from "@/lib/liveTicket";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";

const SECRET = "test-secret-for-live-tickets-0123456789";
const scenario = BUILT_IN_SCENARIOS[0];

describe("GPT-Live switch and settings", () => {
  it("is off unless OPENAI_VOICE_API is exactly live", () => {
    expect(openAiVoiceApi({})).toBe("realtime");
    expect(openAiVoiceApi({ OPENAI_VOICE_API: "realtime" })).toBe("realtime");
    expect(openAiVoiceApi({ OPENAI_VOICE_API: "lively" })).toBe("realtime");
    expect(openAiVoiceApi({ OPENAI_VOICE_API: " LIVE " })).toBe("live");
  });

  it("uses one model for both tiers, overridable by LIVE_MODEL", () => {
    expect(liveModel({})).toBe("gpt-live-1.1");
    expect(liveModel({ LIVE_MODEL: "gpt-live-1" })).toBe("gpt-live-1");
  });

  it("picks the persona's live voice, then a shared realtime voice, then LIVE_VOICE, then marin", () => {
    expect(pickLiveVoice({ liveVoice: "Willow", realtimeVoice: "cedar" }, "stone")).toBe("willow");
    expect(pickLiveVoice({ realtimeVoice: "cedar" }, "stone")).toBe("cedar");
    expect(pickLiveVoice({ realtimeVoice: "ash" }, "stone")).toBe("stone");
    expect(pickLiveVoice({ liveVoice: "not-a-voice" }, "nope")).toBe("marin");
  });

  it("keeps the persona prompt and adds OpenAI's three policy headings, never delegating", () => {
    const text = buildLiveInstructions(scenario);
    expect(text).toContain(`You are ${scenario.aiPersona.name}`);
    expect(text).toContain("Backchannel policy:");
    expect(text).toContain("Interruption policy:");
    expect(text).toContain("Delegation policy:");
    expect(text).toMatch(/Do not delegate to the backend/);
    const custom = buildLiveInstructions({ ...scenario, aiPersona: { ...scenario.aiPersona, liveBackchannel: "Stay silent while they talk.", liveInterruption: "Keep talking over them." } });
    expect(custom).toContain("Backchannel policy: Stay silent while they talk.");
    expect(custom).toContain("Interruption policy: Keep talking over them.");
  });

  it("builds a WebRTC session body with the opening line as a developer message and no audio format", () => {
    const body = liveSessionBody({ model: "m", voice: "marin", instructions: "i", openingLine: "Hello?", sdp: "v=0" });
    expect(body.transport).toEqual({ type: "webrtc", sdp: "v=0" });
    expect(body.session.audio).toEqual({ output: { voice: "marin" } });
    expect(body.session.input?.[0]).toMatchObject({ type: "message", role: "developer" });
    expect(body.session.input?.[0].content[0].text).toContain("\"Hello?\"");
    expect(liveSessionBody({ model: "m", voice: "marin", instructions: "i", openingLine: " ", sdp: "v=0" }).session.input).toBeUndefined();
  });
});

describe("LiveTranscript", () => {
  it("joins a speaker's fragments into one turn and splits on a timeline gap", () => {
    const t = new LiveTranscript(1200, 2000);
    t.add("assistant", "Hi, my ", 0, 300, 0);
    t.add("assistant", "alarm is going off.", 300, 900, 100);
    t.add("user", "Okay, ", 1500, 1700, 200);
    t.add("user", "what's the address?", 1700, 2500, 300);
    t.add("user", "Are you there?", 9000, 9500, 400); // new segment: big gap
    expect(t.flush(5000)).toEqual([
      { role: "assistant", text: "Hi, my alarm is going off." },
      { role: "user", text: "Okay, what's the address? Are you there?" },
    ]);
    expect(t.pending).toBe(0);
  });

  it("does not let a backchannel jump ahead of the sentence it overlapped", () => {
    const t = new LiveTranscript(1200, 2000);
    t.add("user", "So the panel shows ", 1000, 1600, 0);
    t.add("assistant", "mm-hm", 1500, 1700, 50);
    // Persona backchannel went idle but the trainee is still talking: nothing is released yet.
    t.add("user", "zone four.", 2600, 3000, 2100);
    expect(t.flush(2200)).toEqual([]);
    expect(t.flush(5000)).toEqual([
      { role: "user", text: "So the panel shows zone four." },
      { role: "assistant", text: "mm-hm" },
    ]);
  });

  it("force releases everything on hang-up and maps only transcript events", () => {
    const t = new LiveTranscript();
    expect(applyLiveEvent(t, { type: "session.input_transcript.delta", delta: "Hello", start_ms: 0, end_ms: 200 }, 0)).toBe(true);
    expect(applyLiveEvent(t, { type: "session.output_transcript.delta", delta: "Hi there", start_ms: 300, end_ms: 600 }, 0)).toBe(true);
    expect(applyLiveEvent(t, { type: "session.usage.updated", usage: { seconds: 3 } }, 0)).toBe(false);
    expect(t.flush(1, true)).toEqual([{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi there" }]);
  });
});

describe("live tickets", () => {
  beforeEach(() => resetLiveTickets());

  it("open once, for the same user and call only, while fresh", () => {
    const now = 1_000_000;
    const ticket = sealLiveTicket("user-1", "call-abcdef12", { model: "gpt-live-1.1", voice: "marin" }, now, SECRET)!;
    expect(ticket.startsWith("lt1.")).toBe(true);
    expect(ticket).not.toContain("gpt-live");
    expect(openLiveTicket(ticket, "user-2", "call-abcdef12", now, SECRET)).toBeNull();
    expect(openLiveTicket(ticket, "user-1", "call-other-99", now, SECRET)).toBeNull();
    expect(openLiveTicket(ticket, "user-1", "call-abcdef12", now + 3 * 60_000, SECRET)).toBeNull();
    expect(openLiveTicket(ticket, "user-1", "call-abcdef12", now, SECRET)).toEqual({ model: "gpt-live-1.1", voice: "marin" });
    expect(openLiveTicket(ticket, "user-1", "call-abcdef12", now, SECRET)).toBeNull();
  });

  it("are not issued without a secret or with a malformed call id", () => {
    expect(sealLiveTicket("u", "call-abcdef12", { model: "m", voice: "marin" }, 0, undefined)).toBeUndefined();
    expect(sealLiveTicket("u", "bad id!", { model: "m", voice: "marin" }, 0, SECRET)).toBeUndefined();
  });
});

describe("/api/live/sdp", () => {
  const user = { id: "live-user-1", email: "live@example.test" };
  beforeEach(() => {
    resetLiveTickets();
    vi.stubEnv("JWT_SECRET", SECRET);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-live");
    vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

  async function post(body: unknown) {
    vi.doMock("@/lib/apiAuth", () => ({ requireAuth: () => user }));
    const { POST } = await import("@/app/api/live/sdp/route");
    return POST(new NextRequest("http://localhost/api/live/sdp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  }

  it("starts a Live session with the sealed model and voice and returns the SDP answer", async () => {
    const fetchMock = vi.fn(async () => Response.json({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0 answer" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const liveTicket = sealLiveTicket(user.id, "call-abcdef12", { model: "gpt-live-1.1", voice: "willow" })!;
    const res = await post({ liveTicket, sessionId: "call-abcdef12", sdp: "v=0 test offer", scenario });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sdp: "v=0 answer", liveSessionId: "live_1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    const sent = JSON.parse(String(init.body));
    expect(sent.session.model).toBe("gpt-live-1.1");
    expect(sent.session.audio.output.voice).toBe("willow");
    expect(sent.session.instructions).toContain("Delegation policy:");
    expect(sent.transport).toEqual({ type: "webrtc", sdp: "v=0 test offer" });
  });

  it("refuses a ticket for another call without contacting OpenAI", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const liveTicket = sealLiveTicket(user.id, "call-abcdef12", { model: "gpt-live-1.1", voice: "marin" })!;
    const res = await post({ liveTicket, sessionId: "call-zzzzzz99", sdp: "v=0 test offer", scenario });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("realtime_secret_expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the upstream start when the browser aborts its request, without failing over to a backup key", async () => {
    vi.stubEnv("OPENAI_API_KEY_BACKUP_1", "sk-test-live-backup");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let upstream: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      upstream = init?.signal ?? undefined;
      upstream?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("@/lib/apiAuth", () => ({ requireAuth: () => user }));
    const { POST } = await import("@/app/api/live/sdp/route");
    const liveTicket = sealLiveTicket(user.id, "call-abcdef12", { model: "gpt-live-1.1", voice: "marin" })!;
    const browser = new AbortController();
    const pending = POST(new NextRequest("http://localhost/api/live/sdp", {
      method: "POST", headers: { "content-type": "application/json" }, signal: browser.signal,
      body: JSON.stringify({ liveTicket, sessionId: "call-abcdef12", sdp: "v=0 test offer", scenario }),
    }));
    await vi.waitFor(() => expect(upstream).toBeDefined());
    expect(upstream!.aborted).toBe(false);
    browser.abort();
    expect(upstream!.aborted).toBe(true);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never forwards the upstream body or a model id on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "model gpt-live-1.1 not found" } }, { status: 404 })));
    const liveTicket = sealLiveTicket(user.id, "call-abcdef12", { model: "gpt-live-1.1", voice: "marin" })!;
    const res = await post({ liveTicket, sessionId: "call-abcdef12", sdp: "v=0 test offer", scenario });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/gpt-live/i);
  });
});

describe("browser call on the Live path", () => {
  const stop = vi.fn();
  const track = { enabled: true, stop };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  let remote: unknown;
  beforeEach(() => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => mic) } });
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("No audio device in test"); } });
    vi.stubGlobal("Audio", class { autoplay = false; srcObject = null; pause() {} });
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      localDescription = { sdp: "v=0 gathered offer" };
      addTrack() {}
      addEventListener() {}
      removeEventListener() {}
      createDataChannel() { return { readyState: "connecting", close: vi.fn(), send: vi.fn() }; }
      async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
      async setLocalDescription() {}
      async setRemoteDescription(d: unknown) { remote = d; }
      async getStats() { return new Map(); }
      close() {}
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); remote = undefined; });

  it("sends the gathered offer with the ticket to /api/live/sdp and skips the Realtime relay", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ voiceApi: "live", liveTicket: "lt1.ticket", sessionId: "call-abcdef12", voice: "marin" }))
      .mockResolvedValueOnce(Response.json({ sdp: "v=0 answer" }));
    vi.stubGlobal("fetch", fetchMock);
    const h = { onTurn: vi.fn(), onEnded: vi.fn(), onCancelled: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() };
    const call = new RealtimeCall(scenario, h);
    await call.start();
    expect(h.onError).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/live/sdp");
    const sent = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(sent).toMatchObject({ liveTicket: "lt1.ticket", sessionId: "call-abcdef12", sdp: "v=0 gathered offer" });
    expect(remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(h.onMinted).toHaveBeenCalledWith({ sessionId: "call-abcdef12" });
    call.close(false);
  });
});

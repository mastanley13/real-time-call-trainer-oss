import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_STOP_DISCONNECT_MS, CallMeter, CapStopEnd, END_GRACE_MS, readHeartbeat } from "@/lib/callMeter";
import { FREE_END_GRACE_SECONDS } from "@/lib/usagePlan";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { CAP_STOPPED_MESSAGE, FREE_CAP_STOPPED_MESSAGE, FREE_CAP_WARNING_MESSAGE } from "@/lib/billingUi";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// The client side of the Free mid-call cap: the warning is shown once, and a stop ends the call once, through the same
// path as a hang-up. No network: fetch is a stub that answers like /api/usage/heartbeat and /api/usage/end.

type Answer = Record<string, unknown>;
/** A fetch stub: heartbeats get the next queued answer (or a plain "keep going"), everything else is recorded. */
function stubServer(answers: Answer[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url, body });
    if (url === "/api/usage/heartbeat") return Response.json(answers.shift() ?? { stop: false, secondsLeft: 300 });
    if (url === "/api/usage/end") return Response.json({ ok: true });
    if (url === "/api/realtime/session") return Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-1", sessionId: "rt-1", voiceTier: "standard", maxSeconds: 620 });
    if (url === "/api/realtime/sdp") return Response.json({ sdp: "v=0 test answer" });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, heartbeats: () => calls.filter((c) => c.url === "/api/usage/heartbeat"), ends: () => calls.filter((c) => c.url === "/api/usage/end") };
}
/** Lets the pending fetch promises and their .json() reads settle. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("readHeartbeat", () => {
  it("reads a stop, a Free warning and a plain answer, with the server's message or the fallback copy", () => {
    expect(readHeartbeat({ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true })).toEqual({ kind: "stop", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true });
    expect(readHeartbeat({ stop: true, reason: "cap_reached", message: CAP_STOPPED_MESSAGE })).toEqual({ kind: "stop", message: CAP_STOPPED_MESSAGE, freeCap: false });
    expect(readHeartbeat({ stop: true, reason: "ended" })).toEqual({ kind: "stop", message: CAP_STOPPED_MESSAGE, freeCap: false });
    expect(readHeartbeat({ stop: false, secondsLeft: 70, capWarning: true, message: FREE_CAP_WARNING_MESSAGE })).toEqual({ kind: "warn", message: FREE_CAP_WARNING_MESSAGE });
    expect(readHeartbeat({ stop: false, secondsLeft: 70, capWarning: true })).toEqual({ kind: "warn", message: FREE_CAP_WARNING_MESSAGE });
    // secondsLeft alone is never a warning: the client keeps no timer of its own, the server decides.
    expect(readHeartbeat({ stop: false, secondsLeft: 30 })).toEqual({ kind: "ok" });
    expect(readHeartbeat(null)).toEqual({ kind: "ok" });
    expect(readHeartbeat({ stop: "yes", capWarning: "true" })).toEqual({ kind: "ok" });
  });
});

describe("CallMeter", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] }); });

  function connectedMeter(answers: Answer[]) {
    const server = stubServer(answers);
    const h = { onStop: vi.fn(), onGiveUp: vi.fn(), onWarn: vi.fn() };
    const meter = new CallMeter("call-1", h);
    meter.open();
    meter.audio();
    return { server, h, meter };
  }

  it("shows the Free warning once, however many heartbeats carry it", async () => {
    const warn = { stop: false, secondsLeft: 70, capWarning: true, message: FREE_CAP_WARNING_MESSAGE };
    const { h, server } = connectedMeter([{ stop: false, secondsLeft: 200 }, warn, warn, warn]);
    await settle();
    expect(h.onWarn).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(10_000); await settle(); }
    expect(server.heartbeats()).toHaveLength(4);
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.onWarn).toHaveBeenCalledWith(FREE_CAP_WARNING_MESSAGE);
    expect(h.onStop).not.toHaveBeenCalled();
  });

  it("on a stop it calls onStop once and stops heartbeating, and the end is still reported once", async () => {
    const { h, server, meter } = connectedMeter([
      { stop: false, secondsLeft: 15, capWarning: true, message: FREE_CAP_WARNING_MESSAGE },
      { stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true },
      { stop: true, reason: "ended" },
    ]);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledWith(FREE_CAP_STOPPED_MESSAGE, true);
    // No more heartbeats after the stop, so the browser never looks like it outlived the server's stop.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.heartbeats()).toHaveLength(2);
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    // The call then closes the normal way and the end is reported as a hang-up, once.
    meter.end("user_hangup");
    meter.end("user_hangup");
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "user_hangup" } }]);
  });

  it("does nothing without a callId (demo mode)", async () => {
    const server = stubServer([]);
    const h = { onStop: vi.fn(), onGiveUp: vi.fn(), onWarn: vi.fn() };
    const meter = new CallMeter(undefined, h);
    meter.open();
    meter.audio();
    await vi.advanceTimersByTimeAsync(30_000);
    meter.end("user_hangup");
    expect(server.calls).toHaveLength(0);
  });
});

describe("CapStopEnd: the ElevenLabs session's stop (wired as in TrainerClient's VoiceSession)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });

  /**
   * A stand-in for TrainerClient and an ElevenLabs session, in the installed SDK's order: endSession() closes the
   * connection and onDisconnect fires right away, and nothing arrives after the close. The rep's first utterance is in
   * flight when the stop lands; its final transcript arrives `transcriptAt` ms later if the session is still open. The
   * trainer's onError goes back to the briefing when no rep turn is in yet; onEnded grades when one is.
   */
  function elevenLabsCall(opts: { transcriptAt: number; disconnects?: boolean }) {
    const t = { turns: [] as string[], phase: "live" as "live" | "idle", graded: false, errors: [] as string[], meterEnds: [] as string[], order: [] as string[], muted: false, closedAt: -1 };
    let open = true;
    let userEnded = false;
    const t0 = Date.now();
    const onError = (m: string) => { t.errors.push(m); t.order.push("error"); if (!t.turns.length) t.phase = "idle"; };
    const onEnded = () => { t.order.push("ended"); if (t.phase === "live" && t.turns.length) t.graded = true; };
    const meterEnd = (r: string) => { if (!t.meterEnds.length) t.meterEnds.push(r); };
    // Wired as in VoiceSession.
    const capStop = new CapStopEnd({
      mute: () => { t.muted = true; },
      hangUp: () => { userEnded = true; endSession(); },
      report: (m) => onError(m),
      ended: () => { meterEnd("user_hangup"); onEnded(); },
    });
    const onDisconnect = () => { meterEnd(userEnded ? "user_hangup" : "network_drop"); if (capStop.disconnected()) return; onEnded(); };
    const onMessage = (role: "user" | "agent", text: string) => {
      if (t.phase !== "live") return;
      t.turns.push(`${role}: ${text}`);
      t.order.push(`turn:${role}`);
      if (role === "user") capStop.userTranscript();
    };
    function endSession() {
      if (!open) return;
      open = false;
      t.closedAt = Date.now() - t0;
      if (opts.disconnects !== false) onDisconnect(); // the SDK closes, then calls onDisconnect at once
    }
    // The exact paid lambda from VoiceSession (unchanged from main).
    const onStop = (m: string, freeCap: boolean) => capStop.stop(m, freeCap, () => { userEnded = true; endSession(); onError(m); });
    const stopAndRun = async (m: string, freeCap: boolean) => {
      setTimeout(() => { if (open) onMessage("user", "Could you send the quote again?"); }, opts.transcriptAt);
      onStop(m, freeCap);
      await vi.advanceTimersByTimeAsync(6_000);
    };
    return { t, onStop, stopAndRun };
  }

  it("the whole Free stop sequence stays well inside the server's end grace", () => {
    expect(END_GRACE_MS).toBe(1500);
    expect(END_GRACE_MS + CAP_STOP_DISCONNECT_MS).toBeLessThan(FREE_END_GRACE_SECONDS * 1000 / 2);
  });

  it("a Free stop while the first utterance is still transcribing: mic muted, the transcript is kept, then the hang-up, message and grading", async () => {
    const { t, stopAndRun } = elevenLabsCall({ transcriptAt: 800 });
    await stopAndRun(FREE_CAP_STOPPED_MESSAGE, true);
    expect(t.muted).toBe(true);
    expect(t.turns).toEqual(["user: Could you send the quote again?"]);
    expect(t.order).toEqual(["turn:user", "error", "ended"]);
    expect(t.closedAt).toBe(800); // hung up as soon as the final transcript landed, not at the end of the window
    expect(t.errors).toEqual([FREE_CAP_STOPPED_MESSAGE]);
    expect(t.graded).toBe(true);
    expect(t.meterEnds).toEqual(["user_hangup"]);
  });

  it("with no transcript in flight it hangs up when the flush window ends; a transcript after the window is not waited for", async () => {
    const { t, stopAndRun } = elevenLabsCall({ transcriptAt: END_GRACE_MS + 500 });
    await stopAndRun(FREE_CAP_STOPPED_MESSAGE, true);
    expect(t.closedAt).toBe(END_GRACE_MS);
    expect(t.turns).toEqual([]);
    expect(t.order).toEqual(["error", "ended"]); // nothing was said, so back to the briefing with the message
    expect(t.graded).toBe(false);
  });

  it("a Free stop whose disconnect never comes still reports and ends after the bounded wait, once", async () => {
    const { t, stopAndRun, onStop } = elevenLabsCall({ transcriptAt: 400, disconnects: false });
    await stopAndRun(FREE_CAP_STOPPED_MESSAGE, true);
    expect(t.closedAt).toBe(400);
    expect(t.order).toEqual(["turn:user", "error", "ended"]);
    expect(t.graded).toBe(true);
    expect(t.meterEnds).toEqual(["user_hangup"]);
    // A late duplicate stop changes nothing.
    onStop(FREE_CAP_STOPPED_MESSAGE, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.order).toEqual(["turn:user", "error", "ended"]);
  });

  it("a paid stop is unchanged from main: no mute, no flush, the session closes and the message comes at once", async () => {
    const { t, stopAndRun } = elevenLabsCall({ transcriptAt: 800 });
    await stopAndRun(CAP_STOPPED_MESSAGE, false);
    expect(t.muted).toBe(false);
    expect(t.closedAt).toBe(0);
    expect(t.order).toEqual(["ended", "error"]); // main's order: endSession disconnects (onEnded), then onError
    expect(t.turns).toEqual([]); // the in-flight transcript is lost, as on main
    expect(t.errors).toEqual([CAP_STOPPED_MESSAGE]);
    expect(t.meterEnds).toEqual(["user_hangup"]);
  });
});

describe("RealtimeCall: a cap stop ends the call through the hang-up path", () => {
  const scenario = BUILT_IN_SCENARIOS[0];
  const track = { enabled: true, stop: vi.fn() };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  let channel: { readyState: string; close: () => void; send: () => void; onopen?: () => void; onmessage?: (e: { data: string }) => void };
  const serverEvent = (ev: object) => channel.onmessage?.({ data: JSON.stringify(ev) });

  beforeEach(() => {
    vi.stubGlobal("window", { location: { assign: vi.fn() } });
    vi.stubGlobal("localStorage", { removeItem: vi.fn() });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => mic) } });
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("No audio device in test"); } });
    vi.stubGlobal("Audio", class { autoplay = false; muted = false; srcObject = null; pause() {} play() { return Promise.resolve(); } });
    vi.stubGlobal("RTCPeerConnection", class {
      addTrack() {}
      createDataChannel() { channel = { readyState: "connecting", close: vi.fn(), send: vi.fn() }; return channel; }
      async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
    });
  });

  const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn(), onCapWarning: vi.fn() });

  /** Starts a call, opens the data channel and reports first audio, so the meter is heartbeating. */
  async function liveCall(answers: Answer[], beforeAudio?: () => void) {
    const server = stubServer(answers);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    channel.onopen?.();
    beforeAudio?.();
    (call as unknown as { meter: CallMeter }).meter.audio();
    await settle();
    await vi.waitFor(() => expect(server.heartbeats().length).toBeGreaterThan(0));
    await settle();
    return { server, h, call };
  }

  it("the warning reaches the trainer once", async () => {
    const { h, call } = await liveCall([{ stop: false, secondsLeft: 75, capWarning: true, message: FREE_CAP_WARNING_MESSAGE }]);
    expect(h.onCapWarning).toHaveBeenCalledWith(FREE_CAP_WARNING_MESSAGE);
    expect(h.onCapWarning).toHaveBeenCalledTimes(1);
    expect(h.onEnded).not.toHaveBeenCalled();
    call.close(false);
  });

  it("a Free cap stop runs end(): the 'ending' phase, onEnded so the call is saved and graded, a user_hangup end, and the Free message", async () => {
    const { h, server } = await liveCall([{ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true }]);
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1));
    // The same sequence a hang-up produces: wrapping up (mic off, last words flushed), then closed with notify.
    const phases = h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase);
    expect(phases).toContain("ending");
    expect(phases.at(-1)).toBe("closed");
    expect(track.enabled).toBe(false);
    expect(h.onError).toHaveBeenCalledWith(FREE_CAP_STOPPED_MESSAGE);
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "user_hangup" } }]);
  });

  it("a Free cap stop while the rep's first words are still being transcribed keeps them: the turn comes before the message, then the call is graded", async () => {
    const order: string[] = [];
    const { h } = await liveCall(
      [{ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true }],
      // The rep spoke; the audio is committed but its transcript has not arrived when the stop does.
      () => serverEvent({ type: "input_audio_buffer.committed", item_id: "item-rep-1" }),
    );
    h.onTurn.mockImplementation((t: { role: string }) => { order.push(`turn:${t.role}`); });
    // What TrainerClient decides on the message: with no rep turn yet it would go back to the briefing and drop the call.
    h.onError.mockImplementation(() => { order.push("error"); });
    h.onEnded.mockImplementation(() => { order.push("ended"); });
    expect(h.onError).not.toHaveBeenCalled(); // not reported while the hang-up grace waits for the transcript
    serverEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-rep-1", transcript: "Thanks for your time today." });
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1));
    expect(h.onTurn).toHaveBeenCalledWith({ role: "user", text: "Thanks for your time today." });
    expect(order).toEqual(["turn:user", "error", "ended"]);
    expect(h.onError).toHaveBeenCalledWith(FREE_CAP_STOPPED_MESSAGE);
  });

  it("a Free stop seen only as reason 'ended' with freeCap (the cap_reached answer was lost) still takes the hang-up path and keeps the transcript", async () => {
    const order: string[] = [];
    const { h, server } = await liveCall(
      [{ stop: true, reason: "ended", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true }],
      () => serverEvent({ type: "input_audio_buffer.committed", item_id: "item-rep-1" }),
    );
    h.onTurn.mockImplementation((t: { role: string }) => { order.push(`turn:${t.role}`); });
    h.onError.mockImplementation(() => { order.push("error"); });
    h.onEnded.mockImplementation(() => { order.push("ended"); });
    expect(h.onError).not.toHaveBeenCalled();
    serverEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-rep-1", transcript: "Can we talk next week?" });
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["turn:user", "error", "ended"]);
    const phases = h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase);
    expect(phases).toContain("ending");
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "user_hangup" } }]);
  });

  it("a stop with reason 'ended' and no freeCap ends as on main (fail)", async () => {
    const { h } = await liveCall([{ stop: true, reason: "ended" }]);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(CAP_STOPPED_MESSAGE));
    expect(h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase)).not.toContain("ending");
  });

  it("a paid cap stop ends exactly as on main: no hang-up grace, the message, and no grading before the rep spoke", async () => {
    const { h, server } = await liveCall([{ stop: true, reason: "cap_reached", message: CAP_STOPPED_MESSAGE }]);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(CAP_STOPPED_MESSAGE));
    const phases = h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase);
    expect(phases).not.toContain("ending");
    expect(phases.at(-1)).toBe("closed");
    expect(h.onEnded).not.toHaveBeenCalled(); // fail() closes without grading when the rep has not spoken, as on main
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "user_hangup" } }]);
  });

  it("matches a user hang-up: the same phases, onEnded once and the same end report", async () => {
    const { h, server, call } = await liveCall([]);
    call.end();
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1));
    const phases = h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase);
    expect(phases).toContain("ending");
    expect(phases.at(-1)).toBe("closed");
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "user_hangup" } }]);
  });
});

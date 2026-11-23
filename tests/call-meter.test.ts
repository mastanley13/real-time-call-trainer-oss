import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_STOP_DISCONNECT_MS, CAP_STOP_SPEECH_FLUSH_MS, CallMeter, CapStopEnd, END_GRACE_MS, HEARTBEAT_LOST_MESSAGE, HEARTBEAT_REQUEST_TIMEOUT_MS, MAX_FAILED_HEARTBEATS, readHeartbeat } from "@/lib/callMeter";
import { FREE_END_GRACE_SECONDS } from "@/lib/usagePlan";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { CAP_STOPPED_MESSAGE, FREE_CAP_STOPPED_MESSAGE, FREE_CAP_WARNING_MESSAGE } from "@/lib/billingUi";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// The client side of the Free mid-call cap: the warning is shown once, and a stop ends the call once, through the same
// path as a hang-up. No network: fetch is a stub that answers like /api/usage/heartbeat and /api/usage/end.

type Answer = Record<string, unknown>;
/** A heartbeat answer that fails: a network error (fetch rejects) or a non-OK status. */
const NETWORK_ERROR: Answer = { __fail: "network" };
const SERVER_ERROR: Answer = { __fail: 503 };
/**
 * A fetch stub: heartbeats get the next queued answer (or a plain "keep going"), everything else is recorded. `mint`
 * adds fields to the /api/realtime/session answer (freeRule: true for a Free call).
 */
function stubServer(answers: Answer[], mint: Answer = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ url, body });
    if (url === "/api/usage/heartbeat") {
      const a = answers.shift() ?? { stop: false, secondsLeft: 300 };
      if (a.__fail === "network") throw new TypeError("Failed to fetch");
      if (typeof a.__fail === "number") return Response.json({ error: "unavailable" }, { status: a.__fail });
      return Response.json(a);
    }
    if (url === "/api/usage/end") return Response.json({ ok: true });
    if (url === "/api/realtime/session") return Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-1", sessionId: "rt-1", voiceTier: "standard", maxSeconds: 620, ...mint });
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

  /** A connected meter for a Free call (onHeartbeatsLost set, as the voice engines do when the mint says freeRule). */
  function freeMeter(answers: Answer[]) {
    const server = stubServer(answers);
    const h = { onStop: vi.fn(), onGiveUp: vi.fn(), onWarn: vi.fn(), onHeartbeatsLost: vi.fn() };
    const meter = new CallMeter("call-1", h);
    meter.open();
    meter.audio();
    return { server, h, meter };
  }
  /** Lets the next heartbeat go out and its answer land. */
  const nextBeat = async () => { await vi.advanceTimersByTimeAsync(10_000); await settle(); };

  it("a Free call ends after 3 failed heartbeats in a row, not after 2, and stops heartbeating", async () => {
    expect(MAX_FAILED_HEARTBEATS).toBe(3);
    // The connect heartbeat succeeds, then a network error, a 503, and another network error.
    const { h, server } = freeMeter([{ stop: false, secondsLeft: 300 }, NETWORK_ERROR, SERVER_ERROR, NETWORK_ERROR]);
    await settle();
    await nextBeat();
    await nextBeat();
    expect(server.heartbeats()).toHaveLength(3);
    expect(h.onHeartbeatsLost).not.toHaveBeenCalled(); // 2 failures: the call keeps going
    await nextBeat();
    expect(h.onHeartbeatsLost).toHaveBeenCalledTimes(1);
    // No more heartbeats, and the loss is reported once whatever happens next.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.heartbeats()).toHaveLength(4);
    expect(h.onHeartbeatsLost).toHaveBeenCalledTimes(1);
    expect(h.onStop).not.toHaveBeenCalled();
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  it("a Free call counts only failures in a row: a good answer starts the count again", async () => {
    const { h, server } = freeMeter([NETWORK_ERROR, SERVER_ERROR, { stop: false, secondsLeft: 300 }, NETWORK_ERROR, SERVER_ERROR, { stop: false, secondsLeft: 280 }]);
    await settle();
    for (let i = 0; i < 5; i++) await nextBeat();
    expect(server.heartbeats()).toHaveLength(6);
    expect(h.onHeartbeatsLost).not.toHaveBeenCalled();
  });

  it("a paid call (no onHeartbeatsLost) keeps tolerating failed heartbeats, as before", async () => {
    const { h, server } = connectedMeter([NETWORK_ERROR, SERVER_ERROR, NETWORK_ERROR, SERVER_ERROR, NETWORK_ERROR]);
    await settle();
    for (let i = 0; i < 5; i++) await nextBeat();
    expect(server.heartbeats()).toHaveLength(6); // still heartbeating
    expect(h.onStop).not.toHaveBeenCalled();
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });

  /**
   * Heartbeat plans for a network that leaves requests pending. "hang": never settles and ignores the abort (the worst
   * case). "hangAbortable": never settles until aborted, then rejects as fetch does. { afterMs, answer }: answers late.
   */
  type Plan = "hang" | "hangAbortable" | { afterMs: number; answer: Answer };
  function hangingServer(plans: Plan[]) {
    const beats: Array<{ state: unknown; startedAt: number; aborted: boolean; answered: boolean }> = [];
    let overlapped = 0;
    const ends: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (url === "/api/usage/end") { ends.push(body); return Promise.resolve(Response.json({ ok: true })); }
      // Overlap: a heartbeat starting while an earlier one is neither answered nor aborted by the client.
      if (beats.some((b) => !b.aborted && !b.answered)) overlapped += 1;
      const beat = { state: body.state, startedAt: Date.now(), aborted: false, answered: false };
      beats.push(beat);
      init?.signal?.addEventListener("abort", () => { beat.aborted = true; });
      const plan = plans.shift() ?? { afterMs: 0, answer: { stop: false, secondsLeft: 300 } };
      if (plan === "hang") return new Promise<Response>(() => {});
      if (plan === "hangAbortable") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return new Promise<Response>((resolve) => setTimeout(() => { beat.answered = true; resolve(Response.json(plan.answer)); }, plan.afterMs));
    }));
    return { beats, ends, overlapped: () => overlapped };
  }

  describe("a Free call's heartbeat requests are bounded", () => {
    beforeEach(() => {
      vi.useRealTimers(); // the outer block fakes timers without Date; start again with Date faked too
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    });
    const freeHandlers = () => ({ onStop: vi.fn(), onGiveUp: vi.fn(), onWarn: vi.fn(), onHeartbeatsLost: vi.fn() });
    const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };

    it("requests that never answer time out after 8 s and the call shuts down after 3, without overlapping", async () => {
      expect(HEARTBEAT_REQUEST_TIMEOUT_MS).toBe(8_000);
      const server = hangingServer(["hang", "hangAbortable", "hang"]);
      const h = freeHandlers();
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio(); // connect heartbeat at 0 s: pending
      await advance(7_999);
      expect(server.beats).toHaveLength(1);
      expect(server.beats[0].aborted).toBe(false);
      await advance(1); // 8 s: timed out, failure 1
      expect(server.beats[0].aborted).toBe(true);
      await advance(10_000); // 10 s: second request; 18 s: timed out, failure 2
      expect(server.beats).toHaveLength(2);
      expect(server.beats[1].aborted).toBe(true);
      await advance(9_999); // 20 s: third request, pending until 28 s
      expect(server.beats).toHaveLength(3);
      expect(h.onHeartbeatsLost).not.toHaveBeenCalled(); // 2 failures: still on the call
      await advance(1); // 28 s: failure 3
      expect(h.onHeartbeatsLost).toHaveBeenCalledTimes(1);
      expect(server.beats[2].aborted).toBe(true);
      // Nothing more is sent, and the loss is reported once.
      await advance(60_000);
      expect(server.beats).toHaveLength(3);
      expect(h.onHeartbeatsLost).toHaveBeenCalledTimes(1);
      expect(server.beats.map((b) => b.startedAt - server.beats[0].startedAt)).toEqual([0, 10_000, 20_000]);
      expect(server.overlapped()).toBe(0);
      expect(h.onStop).not.toHaveBeenCalled();
    });

    it("a request still in flight blocks the next one: an out-of-band heartbeat is skipped, not overlapped", async () => {
      const server = hangingServer(["hang", { afterMs: 0, answer: { stop: false, secondsLeft: 300 } }]);
      const h = freeHandlers();
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio(); // pending connect heartbeat
      await advance(2_000);
      meter.trouble(); // would send "recovering" now; skipped while the connect heartbeat is in flight
      meter.recovered(); // would send "ok"; skipped too
      await advance(1_000);
      expect(server.beats).toHaveLength(1);
      await advance(7_000); // 10 s: the connect heartbeat timed out at 8 s, the tick sends the next one
      expect(server.beats).toHaveLength(2);
      expect(server.overlapped()).toBe(0);
      meter.end("user_hangup");
    });

    it("a stop answer still ends the call, even after two timeouts, and a slow answer inside 8 s counts", async () => {
      const stop = { stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true };
      const server = hangingServer(["hang", "hang", { afterMs: 7_000, answer: stop }]);
      const h = freeHandlers();
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio();
      await advance(20_000 + 6_999);
      expect(h.onStop).not.toHaveBeenCalled();
      await advance(1); // 27 s: the stop answer, 1 s before that request would have timed out
      expect(h.onStop).toHaveBeenCalledWith(FREE_CAP_STOPPED_MESSAGE, true);
      // Its timeout was cleared: no third failure, no shutdown, and no more heartbeats.
      await advance(60_000);
      expect(h.onHeartbeatsLost).not.toHaveBeenCalled();
      expect(server.beats).toHaveLength(3);
      expect(server.overlapped()).toBe(0);
    });

    it("an answer that arrives after its request timed out is ignored and counts as a failure", async () => {
      const stop = { stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true };
      // The server ignores the abort and answers at 9 s.
      hangingServer([{ afterMs: 9_000, answer: stop }, "hang", "hang"]);
      const h = freeHandlers();
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio();
      await advance(9_500);
      expect(h.onStop).not.toHaveBeenCalled();
      await advance(20_000); // two more timeouts: 3 failures in a row
      expect(h.onHeartbeatsLost).toHaveBeenCalledTimes(1);
      expect(h.onStop).not.toHaveBeenCalled();
    });

    it("end() clears the request timeout: no failure is counted after the call ended", async () => {
      const server = hangingServer(["hang"]);
      const h = freeHandlers();
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio();
      await advance(1_000);
      meter.end("user_hangup");
      expect(server.beats[0].aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await advance(60_000);
      expect(server.beats).toHaveLength(1);
      expect(server.ends).toEqual([{ callId: "call-1", reason: "user_hangup" }]);
      expect(h.onHeartbeatsLost).not.toHaveBeenCalled();
    });

    it("a paid call (no onHeartbeatsLost) keeps its heartbeats as before: no timeout, one per tick", async () => {
      const server = hangingServer(["hang", "hang", "hang", "hang"]);
      const h = { onStop: vi.fn(), onGiveUp: vi.fn(), onWarn: vi.fn() };
      const meter = new CallMeter("call-1", h);
      meter.open();
      meter.audio();
      await advance(30_000);
      expect(server.beats).toHaveLength(4);
      expect(server.beats.every((b) => !b.aborted)).toBe(true);
      expect(h.onStop).not.toHaveBeenCalled();
      expect(h.onGiveUp).not.toHaveBeenCalled();
      meter.end("user_hangup");
    });
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

  const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onCancelled: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn(), onCapWarning: vi.fn() });

  /** Starts a call, opens the data channel and reports first audio, so the meter is heartbeating. */
  async function liveCall(answers: Answer[], beforeAudio?: () => void, mint: Answer = {}) {
    const server = stubServer(answers, mint);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    channel.onopen?.();
    beforeAudio?.();
    (call as unknown as { attempt: { meter: CallMeter } }).attempt.meter.audio();
    await settle();
    await vi.waitFor(() => expect(server.heartbeats().length).toBeGreaterThan(0));
    await settle();
    return { server, h, call };
  }

  it("a Free call whose heartbeats fail 3 times in a row ends as a network drop with the connection message", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { h, server } = await liveCall([{ stop: false, secondsLeft: 300 }, NETWORK_ERROR, SERVER_ERROR, NETWORK_ERROR], undefined, { freeRule: true });
    for (let i = 0; i < 2; i++) { await vi.advanceTimersByTimeAsync(10_000); await settle(); }
    expect(h.onError).not.toHaveBeenCalled(); // 2 failures: still on the call
    expect(server.ends()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(HEARTBEAT_LOST_MESSAGE));
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(server.ends()).toEqual([{ url: "/api/usage/end", body: { callId: "call-1", reason: "network_drop" } }]);
    expect(h.onView.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "closed" });
  });

  it("a paid call (no freeRule in the mint answer) keeps running through failed heartbeats, as before", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { h, server, call } = await liveCall([{ stop: false, secondsLeft: 300 }, NETWORK_ERROR, SERVER_ERROR, NETWORK_ERROR, SERVER_ERROR]);
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(10_000); await settle(); }
    expect(server.heartbeats()).toHaveLength(5);
    expect(h.onError).not.toHaveBeenCalled();
    expect(server.ends()).toEqual([]);
    call.close(false);
  });

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

  /** Types of the client events sent on the data channel. */
  const sent = () => (channel.send as unknown as { mock: { calls: [string][] } }).mock.calls.map(([d]) => (JSON.parse(d) as { type: string }).type);
  const phasesOf = (h: ReturnType<typeof handlers>) => h.onView.mock.calls.map(([v]) => (v as { phase: string }).phase);
  /** The rep is mid-utterance: the server saw speech start and has committed nothing, so the assembler is empty. */
  const repStillSpeaking = () => { channel.readyState = "open"; serverEvent({ type: "input_audio_buffer.speech_started", item_id: "item-rep-1" }); };

  it("a Free cap stop while the rep is still speaking (nothing committed): mic off, buffer committed, then the transcript is kept and graded", async () => {
    track.enabled = true;
    const order: string[] = [];
    const { h } = await liveCall([{ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true }], repStillSpeaking);
    h.onTurn.mockImplementation((t: { role: string }) => { order.push(`turn:${t.role}`); });
    h.onError.mockImplementation(() => { order.push("error"); });
    h.onEnded.mockImplementation(() => { order.push("ended"); });
    // Waiting inside the flush window: the mic sends nothing more, the server is asked to commit, the call is still open.
    expect(track.enabled).toBe(false);
    expect(sent()).toContain("input_audio_buffer.commit");
    expect(phasesOf(h)).not.toContain("ending");
    expect(h.onEnded).not.toHaveBeenCalled();
    // The server commits the speech and transcribes it within the window.
    serverEvent({ type: "input_audio_buffer.committed", item_id: "item-rep-1" });
    serverEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-rep-1", transcript: "Let me check with my manager." });
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1));
    expect(h.onTurn).toHaveBeenCalledWith({ role: "user", text: "Let me check with my manager." });
    expect(order).toEqual(["turn:user", "error", "ended"]);
    expect(phasesOf(h)).toContain("ending"); // then the normal hang-up path
  });

  it("the speech flush window expires when no commit or transcript arrives, then the call hangs up as usual", async () => {
    const { h } = await liveCall([{ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true }], repStillSpeaking);
    const stoppedAt = Date.now();
    await vi.waitFor(() => expect(h.onEnded).toHaveBeenCalledTimes(1), { timeout: CAP_STOP_SPEECH_FLUSH_MS + 2_000, interval: 50 });
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(CAP_STOP_SPEECH_FLUSH_MS - 150);
    expect(Date.now() - stoppedAt).toBeLessThan(CAP_STOP_SPEECH_FLUSH_MS + END_GRACE_MS + 500);
    expect(h.onError).toHaveBeenCalledWith(FREE_CAP_STOPPED_MESSAGE);
    expect(h.onTurn).not.toHaveBeenCalled(); // nothing was transcribed, so the trainer goes back to the briefing
    expect(CAP_STOP_SPEECH_FLUSH_MS + END_GRACE_MS).toBeLessThan(FREE_END_GRACE_SECONDS * 1000 / 2);
  }, 10_000);

  it("a paid cap stop with speech in flight is unchanged from main: no commit, no wait", async () => {
    const { h } = await liveCall([{ stop: true, reason: "cap_reached", message: CAP_STOPPED_MESSAGE }], repStillSpeaking);
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith(CAP_STOPPED_MESSAGE));
    expect(sent()).not.toContain("input_audio_buffer.commit");
    expect(phasesOf(h)).not.toContain("ending");
    expect(phasesOf(h).at(-1)).toBe("closed");
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

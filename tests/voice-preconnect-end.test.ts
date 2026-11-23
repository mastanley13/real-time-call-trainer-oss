import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallMeter, HEARTBEAT_LOST_MESSAGE, MAX_FAILED_HEARTBEATS } from "@/lib/callMeter";
import { DROPPED_BEFORE_CONNECT_MESSAGE, ENDED_BEFORE_CONNECT_MESSAGE, LEFT_BEFORE_CONNECT_MESSAGE, VoiceAttempt } from "@/lib/voiceAttempt";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { ElevenLabsStart } from "@/components/call/elevenLabsStart";
import { resetSessionExpiryRedirect } from "@/lib/sessionExpiry";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// Every way a voice attempt can end before the meter connects goes through the attempt's one cancel()
// (src/lib/voiceAttempt.ts, table at the top). Each test below names the table row it covers. Connected calls keep
// their own paths and billing, tested at the end.

const scenario = BUILT_IN_SCENARIOS[0];
interface FakeDc { readyState: string; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; close: () => void; send: () => void }
interface FakePc {
  connectionState: string;
  onconnectionstatechange?: () => void;
  ontrack?: (e: { streams: unknown[] }) => void;
  dc: FakeDc;
  closed: boolean;
  remoteSet: number;
}
let page: EventTarget;
let fetchMock: ReturnType<typeof vi.fn>;
let lastPc: FakePc | null;
const track = { enabled: true, stop: vi.fn() };
const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onCancelled: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });
const noop = { onStop: () => {}, onGiveUp: () => {} };
const elHandlers = () => ({ onEnded: vi.fn(), onError: vi.fn(), onCancelled: vi.fn(), endSession: vi.fn() });
const FAILED_ONCE = (callId: string) => [{ callId, reason: "failed_connect", keepalive: true }];

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;
/** fetch stub: /api/usage/* answers 200; anything else goes to `route`. */
function stubFetch(route: Route = () => Response.json({})) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => (String(url).startsWith("/api/usage/") ? Response.json({}) : route(String(url), init)));
  vi.stubGlobal("fetch", fetchMock);
}
const posted = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => ({ ...JSON.parse(String((init as RequestInit).body)), keepalive: (init as RequestInit).keepalive }));
const ends = () => posted("/api/usage/end");
const beats = () => posted("/api/usage/heartbeat");
const urls = () => fetchMock.mock.calls.map(([u]) => u);
const flush = () => new Promise((r) => setTimeout(r, 0));
const pageHide = () => page.dispatchEvent(new Event("pagehide"));
const pageShowPersisted = () => page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const pageListeners = () => (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.length - (window.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiryRedirect();
  page = new EventTarget();
  lastPc = null;
  vi.stubGlobal("window", {
    location: { origin: "https://trainer.example.test", pathname: "/trainer", search: "", assign: vi.fn() },
    addEventListener: vi.fn(page.addEventListener.bind(page)),
    removeEventListener: vi.fn(page.removeEventListener.bind(page)),
  });
  vi.stubGlobal("localStorage", { getItem: () => null, removeItem: () => {} });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => mic) } });
  vi.stubGlobal("AudioContext", class { constructor() { throw new Error("No audio device in test"); } });
  vi.stubGlobal("Audio", class { autoplay = false; srcObject = null; muted = false; pause() {} async play() {} });
  vi.stubGlobal("RTCPeerConnection", class implements FakePc {
    connectionState = "new";
    onconnectionstatechange?: () => void;
    ontrack?: (e: { streams: unknown[] }) => void;
    iceGatheringState = "complete";
    localDescription = { sdp: "v=0 test offer" };
    dc: FakeDc = { readyState: "connecting", close() {}, send() {} };
    closed = false;
    remoteSet = 0;
    constructor() { lastPc = this; }
    addTrack() {}
    createDataChannel() { return this.dc; }
    async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.remoteSet += 1; }
    async getStats() { return new Map([["a", { type: "inbound-rtp", kind: "audio", packetsReceived: 5 }]]); }
    close() { this.closed = true; }
  });
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

// ---- The shared attempt ---------------------------------------------------------------------------------------------

describe("VoiceAttempt: the one cancel", () => {
  const owner = () => ({ teardown: vi.fn(), onCancelled: vi.fn() });

  it("is idempotent: one teardown, one report, one screen message", () => {
    const o = owner();
    const a = new VoiceAttempt(o);
    a.minted("call-1", noop);
    expect(a.cancel("hang_up")).toBe(true);
    expect(a.cancel("page_hide")).toBe(false);
    expect(a.cancel("error", "Again")).toBe(false);
    expect(o.teardown).toHaveBeenCalledOnce();
    expect(o.onCancelled).toHaveBeenCalledOnce();
    expect(o.onCancelled).toHaveBeenCalledWith(ENDED_BEFORE_CONNECT_MESSAGE);
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
    expect(a.live).toBe(false);
  });

  it("does nothing once the meter connected (the caller takes the connected path)", () => {
    const o = owner();
    const a = new VoiceAttempt(o);
    a.minted("call-1", noop);
    a.meter.open();
    a.meter.audio();
    expect(a.cancel("hang_up")).toBe(false);
    pageHide();
    expect(o.teardown).not.toHaveBeenCalled();
    expect(ends()).toEqual([]);
    a.meter.end("user_hangup");
  });

  it("reports nothing without a callId, but still tears down and returns the screen", () => {
    const o = owner();
    const a = new VoiceAttempt(o);
    a.minted(undefined, noop);
    a.cancel("error", "Something failed.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(o.teardown).toHaveBeenCalledOnce();
    expect(o.onCancelled).toHaveBeenCalledWith("Something failed.");
  });

  it("unmount and superseded exits have no screen", () => {
    for (const exit of ["unmount", "superseded"] as const) {
      const o = owner();
      new VoiceAttempt(o).cancel(exit);
      expect(o.teardown).toHaveBeenCalledOnce();
      expect(o.onCancelled).not.toHaveBeenCalled();
    }
  });

  it("the page-hide observer runs from the start until the meter connects, with or without a callId", () => {
    for (const callId of ["call-1", undefined]) {
      const before = pageListeners();
      const a = new VoiceAttempt(owner());
      expect(pageListeners()).toBe(before + 1);
      a.minted(callId, noop);
      expect(pageListeners()).toBe(before + 1);
      a.meter.open();
      a.meter.audio();
      expect(pageListeners()).toBe(before);
      a.meter.end("user_hangup");
    }
  });

  it("the observer is removed when the attempt is cancelled or finished", () => {
    const before = pageListeners();
    new VoiceAttempt(owner()).cancel("hang_up");
    new VoiceAttempt(owner()).finish();
    expect(pageListeners()).toBe(before);
  });

  it("row 7: a mint that answers after the cancel reports its callId at once and says not to go on", () => {
    const o = owner();
    const a = new VoiceAttempt(o);
    a.cancel("page_hide");
    expect(a.minted("call-1", noop)).toBe(false);
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
    a.meter.open();
    a.meter.audio();
    expect(beats()).toEqual([]);
  });
});

// ---- Rows 1, 2, 3, 5, 7, 17 on every engine, at every step, metered and unmetered -----------------------------------

type Engine = "Realtime" | "GPT-Live" | "ElevenLabs";
type Stage = "mic prompt" | "mint pending" | "connecting" | "transport up, no audio";
type Exit = "hang-up" | "page hide" | "unmount";
interface Driven {
  exit: (e: Exit) => Promise<void>;
  /** Everything that can still arrive after the exit: the mic stream, the mint answer, the SDP answer, connect, audio. */
  late: () => Promise<void>;
  onEnded: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onCancelled: ReturnType<typeof vi.fn>;
  onTurn: ReturnType<typeof vi.fn>;
  tornDown: () => boolean;
}

function mintAnswer(engine: Engine, callId: string | undefined) {
  const id = callId ? { callId } : {};
  if (engine === "ElevenLabs") return Response.json({ token: "tok_fictional_test_only", ...id });
  if (engine === "GPT-Live") return Response.json({ voiceApi: "live", liveTicket: "lt_fictional_test_only", sessionId: "s-x", ...id });
  return Response.json({ clientSecret: "ek_fictional_test_only", sessionId: "s-x", ...id });
}

async function drive(engine: Engine, stage: Stage, callId: string | undefined): Promise<Driven> {
  const mint = deferred<Response>();
  const stream = deferred<typeof mic>();
  stubFetch((url) => (url.endsWith("/sdp") ? Response.json({ sdp: "v=0 answer" }) : stage === "mint pending" ? mint.promise : mintAnswer(engine, callId)));

  if (engine === "ElevenLabs") {
    const h = elHandlers();
    const onTurn = vi.fn();
    const call = new ElevenLabsStart(h);
    call.mount();
    const pending = call.mint("/api/elevenlabs/token", noop);
    let sdk: ReturnType<ElevenLabsStart["sessionCallbacks"]> | undefined;
    if (stage === "mint pending") await flush();
    else {
      const data = await pending;
      sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => false });
      if (stage === "transport up, no audio") sdk.onConnect();
    }
    return {
      exit: async (e) => { if (e === "hang-up") call.hangUp(); else if (e === "page hide") pageHide(); else call.unmount(); await flush(); },
      late: async () => {
        mint.resolve(mintAnswer(engine, callId));
        const answered = await pending.catch(() => null);
        if (stage === "mint pending") expect(answered).toBeNull(); // row 7: reported, never started
        sdk?.onConnect();
        sdk?.onMessage({ message: "Hello?", role: "user" });
        sdk?.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
        sdk?.onError("Late error");
        sdk?.onDisconnect();
        await flush();
      },
      onEnded: h.onEnded, onError: h.onError, onCancelled: h.onCancelled, onTurn,
      tornDown: () => h.endSession.mock.calls.length > 0,
    };
  }

  if (stage === "mic prompt") vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => stream.promise) } });
  const h = handlers();
  const call = new RealtimeCall(scenario, h);
  const started = call.start();
  if (stage === "mic prompt" || stage === "mint pending") await flush();
  else await started;
  if (stage === "transport up, no audio") { lastPc!.dc.readyState = "open"; lastPc!.dc.onopen!(); }
  return {
    exit: async (e) => { if (e === "hang-up") call.end(); else if (e === "page hide") pageHide(); else call.close(false); await flush(); },
    late: async () => {
      stream.resolve(mic);
      mint.resolve(mintAnswer(engine, callId));
      await started;
      if (lastPc) {
        lastPc.dc.readyState = "open";
        lastPc.dc.onopen?.();
        lastPc.ontrack?.({ streams: [{ getTracks: () => [] }] });
        lastPc.dc.onmessage?.({ data: JSON.stringify({ type: "error", error: { code: "session_expired" } }) });
      }
      await flush();
    },
    onEnded: h.onEnded, onError: h.onError, onCancelled: h.onCancelled, onTurn: h.onTurn,
    // During the mic prompt there is no stream yet: the one that arrives later is stopped (checked after late()).
    tornDown: () => (stage === "mic prompt" || track.stop.mock.calls.length > 0) && (lastPc ? lastPc.closed : true),
  };
}

const SCREEN: Record<Exit, string | null> = {
  "hang-up": ENDED_BEFORE_CONNECT_MESSAGE, // row 1
  "page hide": LEFT_BEFORE_CONNECT_MESSAGE, // row 2
  unmount: null, // row 3: no screen
};

describe("rows 1, 2, 3, 5, 7 and 17: hang-up, page hide and unmount at every step before connect", () => {
  const engines: Engine[] = ["Realtime", "GPT-Live", "ElevenLabs"];
  const stages: Stage[] = ["mic prompt", "mint pending", "connecting", "transport up, no audio"];
  for (const engine of engines)
    for (const stage of stages) {
      if (engine === "ElevenLabs" && stage === "mic prompt") continue; // the SDK asks for the mic after the token
      for (const exit of ["hang-up", "page hide", "unmount"] as const)
        for (const metered of [true, false]) {
          it(`${engine}, ${exit} during ${stage}, ${metered ? "metered" : "unmetered"}`, async () => {
            const callId = metered ? "call-x" : undefined;
            const d = await drive(engine, stage, callId);
            await d.exit(exit);
            expect(d.tornDown()).toBe(true);
            if (SCREEN[exit]) expect(d.onCancelled).toHaveBeenCalledWith(SCREEN[exit]);
            else expect(d.onCancelled).not.toHaveBeenCalled();
            // Back to the briefing without grading: never the connected-call end or error.
            expect(d.onEnded).not.toHaveBeenCalled();
            expect(d.onError).not.toHaveBeenCalled();

            pageShowPersisted(); // the page may come back from the back/forward cache
            await d.late();
            // failed_connect once when a callId exists (row 7 when it arrives late); never without one or before a mint.
            expect(ends()).toEqual(metered && stage !== "mic prompt" ? FAILED_ONCE("call-x") : []);
            expect(beats()).toEqual([]);
            expect(d.onTurn).not.toHaveBeenCalled();
            expect(d.onCancelled).toHaveBeenCalledTimes(SCREEN[exit] ? 1 : 0);
            expect(d.onEnded).not.toHaveBeenCalled();
            expect(d.onError).not.toHaveBeenCalled();
            if (stage === "mic prompt") {
              // Row 5: the stream granted after the exit is stopped, and nothing is minted.
              expect(track.stop).toHaveBeenCalled();
              expect(urls()).toEqual([]);
            }
          });
        }
    }
});

// ---- One test per remaining row --------------------------------------------------------------------------------------

describe("row 4: mic permission denied", () => {
  it("Realtime and GPT-Live: getUserMedia rejects, nothing is minted, back to the briefing with the mic message", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); }) } });
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("ElevenLabs: the SDK start fails on the mic and calls onError: one cancel, session ended, later callbacks ignored", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const onTurn = vi.fn();
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => false });
    sdk.onError("Permission denied");
    expect(h.onCancelled).toHaveBeenCalledWith("Permission denied");
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    sdk.onDisconnect();
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(h.onEnded).not.toHaveBeenCalled();
  });
});

describe("row 6: mint error", () => {
  it.each([
    ["an HTTP error", () => Response.json({ error: "minutes_reserved", message: "Your minutes are held by another call." }, { status: 409 }), "Your minutes are held by another call."],
    ["a network failure", () => { throw new TypeError("network"); }, "Could not reach the server to start the voice call. Check your connection, then try again."],
    ["an answer with no secret", () => Response.json({}), "Could not start the voice call. Try again, or switch to Text."],
  ])("Realtime and GPT-Live, %s: back to the briefing with the message, mic stopped, nothing to report", async (_l, answer, message) => {
    stubFetch(answer as Route);
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(h.onCancelled).toHaveBeenCalledWith(message);
    expect(track.stop).toHaveBeenCalled();
    expect(ends()).toEqual([]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("ElevenLabs: the mint throws and the caller passes the message to failed(): back to the briefing, nothing to report", async () => {
    stubFetch(() => Response.json({ error: "minutes_reserved", message: "Your minutes are held by another call." }, { status: 409 }));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const err = await call.mint("/api/elevenlabs/token", noop).catch((e: Error) => e);
    call.failed((err as Error).message);
    expect(h.onCancelled).toHaveBeenCalledWith("Your minutes are held by another call.");
    expect(ends()).toEqual([]);
  });
});

describe("row 8: the mint answer never reaches the page", () => {
  it.each(["Realtime", "ElevenLabs"] as const)("%s: the page hide still cancels the attempt; nothing can be reported (the server reclaims it after 45 s)", async (engine) => {
    const d = await drive(engine, "mint pending", "call-x");
    await d.exit("page hide");
    expect(d.tornDown()).toBe(true);
    expect(d.onCancelled).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
    expect(ends()).toEqual([]);
  });
});

describe("row 9: the session expired at the mint or the SDP exchange", () => {
  it("Realtime: an access-code 401 after a metered mint reports the call once, stops the mic and peer, then navigates", async () => {
    stubFetch((url) => (url === "/api/realtime/sdp" ? Response.json({ error: "access_code_required" }, { status: 401 }) : mintAnswer("Realtime", "call-rt")));
    const assign = window.location.assign as ReturnType<typeof vi.fn>;
    assign.mockImplementation(() => {
      expect(ends()).toEqual(FAILED_ONCE("call-rt"));
      expect(lastPc!.closed).toBe(true);
      expect(track.stop).toHaveBeenCalled();
    });
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(assign).toHaveBeenCalledWith("/access");
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
  });
});

describe("row 10: the voice secret expired before connecting", () => {
  it.each(["Realtime", "GPT-Live"] as const)("%s: one cancel with the expiry message", async (engine) => {
    stubFetch(() => (engine === "GPT-Live"
      ? Response.json({ voiceApi: "live", liveTicket: "lt_fictional_test_only", sessionId: "s-x", callId: "call-x", expiresAt: 1 })
      : Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-x", expiresAt: 1 })));
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(h.onCancelled).toHaveBeenCalledWith("The voice session expired before it connected. Start the call again.");
    expect(ends()).toEqual(FAILED_ONCE("call-x"));
  });
});

describe("row 11: SDP exchange error or network failure", () => {
  it.each([
    ["Realtime, an HTTP error", "/api/realtime/sdp", () => Response.json({ error: "upstream_error", message: "OpenAI could not connect." }, { status: 502 }), "OpenAI could not connect."],
    ["Realtime, a network failure", "/api/realtime/sdp", () => { throw new TypeError("network"); }, "Could not connect the voice call. Check your network and try again, or switch to Text."],
    ["GPT-Live, an expired ticket", "/api/live/sdp", () => Response.json({ error: "realtime_secret_expired" }, { status: 400 }), "The voice session expired before it connected. Start the call again."],
  ])("%s: one cancel with the message, peer and mic closed", async (label, sdpUrl, answer, message) => {
    const engine: Engine = label.startsWith("GPT-Live") ? "GPT-Live" : "Realtime";
    stubFetch((url) => (url === sdpUrl ? (answer as Route)(url) : mintAnswer(engine, "call-x")));
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(h.onCancelled).toHaveBeenCalledWith(message);
    expect(lastPc!.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(ends()).toEqual(FAILED_ONCE("call-x"));
  });
});

describe("row 12: provider error before connect", () => {
  it("Realtime: a session_expired event before the first audio is one cancel; nothing is graded", async () => {
    stubFetch((url) => (url.endsWith("/sdp") ? Response.json({ sdp: "v=0 answer" }) : mintAnswer("Realtime", "call-x")));
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen!();
    lastPc!.dc.onmessage!({ data: JSON.stringify({ type: "error", error: { code: "session_expired" } }) });
    expect(h.onCancelled).toHaveBeenCalledWith("The voice session expired before it connected. Start the call again.");
    expect(lastPc!.closed).toBe(true);
    expect(ends()).toEqual(FAILED_ONCE("call-x"));
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("ElevenLabs: an SDK error after a rep turn already arrived still cancels; later connect and messages are ignored", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const onTurn = vi.fn();
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => false });
    sdk.onConnect();
    sdk.onMessage({ message: "Hello?", role: "user" }); // a rep turn before the first agent audio
    expect(onTurn).toHaveBeenCalledOnce();
    sdk.onError("Voice connection error");
    expect(h.onCancelled).toHaveBeenCalledWith("Voice connection error");
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled(); // the trainer's onError would keep the screen open with a rep turn
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    sdk.onMessage({ message: "Are you there?", role: "user" });
    sdk.onDisconnect();
    expect(h.endSession).toHaveBeenCalledTimes(2); // the late connect is ended
    expect(onTurn).toHaveBeenCalledOnce();
    expect(beats()).toEqual([]);
    expect(h.onEnded).not.toHaveBeenCalled();
  });
});

describe("row 13: transport closed before connect", () => {
  async function realtimeConnecting(engine: Engine = "Realtime") {
    stubFetch((url) => (url.endsWith("/sdp") ? Response.json({ sdp: "v=0 answer" }) : mintAnswer(engine, "call-x")));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    return { h, call };
  }
  const expectDropped = (h: ReturnType<typeof handlers>) => {
    expect(h.onCancelled).toHaveBeenCalledWith(DROPPED_BEFORE_CONNECT_MESSAGE);
    expect(h.onError).not.toHaveBeenCalled();
    expect(lastPc!.closed).toBe(true);
    expect(ends()).toEqual(FAILED_ONCE("call-x"));
  };

  it("Realtime: the peer connection fails", async () => {
    const { h } = await realtimeConnecting();
    lastPc!.connectionState = "failed";
    lastPc!.onconnectionstatechange!();
    expectDropped(h);
  });

  it("Realtime: the data channel closes", async () => {
    const { h } = await realtimeConnecting();
    lastPc!.dc.onclose!();
    expectDropped(h);
  });

  it("Realtime: a disconnect that does not recover in 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { h } = await realtimeConnecting();
    lastPc!.connectionState = "disconnected";
    lastPc!.onconnectionstatechange!();
    await vi.advanceTimersByTimeAsync(10_001);
    expectDropped(h);
  });

  it("GPT-Live: session.closed before the first audio", async () => {
    const { h } = await realtimeConnecting("GPT-Live");
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen!();
    lastPc!.dc.onmessage!({ data: JSON.stringify({ type: "session.closed", reason: "server_error" }) });
    expectDropped(h);
  });

  it("ElevenLabs: the SDK disconnects before the first agent audio", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn: vi.fn(), userEnded: () => false });
    sdk.onConnect();
    sdk.onDisconnect();
    expect(h.onCancelled).toHaveBeenCalledWith(DROPPED_BEFORE_CONNECT_MESSAGE);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });
});

describe("row 14: startSession throws after the mint", () => {
  it("ElevenLabs: failed() is one cancel with the message", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    await call.mint("/api/elevenlabs/token", noop);
    call.failed("Failed to start the call.");
    call.failed("Again");
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(h.onCancelled).toHaveBeenCalledWith("Failed to start the call.");
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });
});

describe("row 15: a new attempt starts while one is before connect", () => {
  it("ElevenLabs: a new mint supersedes the old attempt: reported once, session ended, no screen, its callbacks ignored", async () => {
    let n = 0;
    stubFetch(() => mintAnswer("ElevenLabs", `call-${++n}`));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const first = await call.mint("/api/elevenlabs/token", noop);
    const onTurn = vi.fn();
    const old = call.sessionCallbacks(first!.attempt, { onTurn, userEnded: () => false });
    const second = await call.mint("/api/elevenlabs/token", noop);
    expect(second!.attempt).not.toBe(first!.attempt);
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(h.onCancelled).not.toHaveBeenCalled();
    old.onMessage({ message: "Late line", role: "agent" });
    old.onDisconnect();
    expect(onTurn).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("Realtime and GPT-Live: each mount owns one call, and the old one is unmounted (row 3): reported once", async () => {
    let n = 0;
    stubFetch((url) => (url.endsWith("/sdp") ? Response.json({ sdp: "v=0 answer" }) : mintAnswer("Realtime", `call-${++n}`)));
    const old = new RealtimeCall(scenario, handlers());
    await old.start();
    old.close(false);
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
  });
});

describe("row 3 detail: the ElevenLabs unmount waits one task for a StrictMode remount", () => {
  it("a remount in the same task keeps the attempt; a real unmount later cancels it", async () => {
    const mint = deferred<Response>();
    stubFetch(() => mint.promise);
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const pending = call.mint("/api/elevenlabs/token", noop);
    call.unmount();
    call.mount();
    await flush();
    mint.resolve(mintAnswer("ElevenLabs", "call-el"));
    expect(await pending).toMatchObject({ callId: "call-el" });
    expect(call.isCancelled).toBe(false);
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(h.onCancelled).not.toHaveBeenCalled();
  });
});

// ---- Connected calls: unchanged --------------------------------------------------------------------------------------

describe("after the meter connected, nothing above applies", () => {
  it("CallMeter: the reason is sent as given and connect needs the channel open AND the first audio", () => {
    for (const id of ["call-1", undefined]) {
      const m = new CallMeter(id, noop);
      m.open();
      expect(m.isConnected).toBe(false);
      m.audio();
      expect(m.isConnected).toBe(true);
      m.end("user_hangup");
    }
    expect(beats()).toEqual([{ callId: "call-1", state: "connected" }]);
    expect(ends()).toEqual([{ callId: "call-1", reason: "user_hangup", keepalive: true }]);
  });

  it("CallMeter: before connect any end is sent once as failed_connect, and an ended meter never connects", () => {
    const m = new CallMeter("call-1", noop);
    m.end("network_drop");
    m.end("user_hangup");
    m.open();
    m.audio();
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
    expect(beats()).toEqual([]);
  });

  it("Realtime: hang-up takes the connected path (ending phase) and reports user_hangup; page hide leaves it running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    stubFetch((url) => (url.endsWith("/sdp") ? Response.json({ sdp: "v=0 answer" }) : mintAnswer("Realtime", "call-rt")));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen!();
    lastPc!.ontrack!({ streams: [{ getTracks: () => [] }] });
    await vi.advanceTimersByTimeAsync(600);
    expect(beats()).toEqual([{ callId: "call-rt", state: "connected" }]);
    pageHide();
    expect(lastPc!.closed).toBe(false);
    expect(ends()).toEqual([]);
    call.end();
    expect(h.onView).toHaveBeenCalledWith(expect.objectContaining({ phase: "ending" }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastPc!.closed).toBe(true);
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(ends()).toEqual([{ callId: "call-rt", reason: "user_hangup", keepalive: true }]);
  });

  it("ElevenLabs: hang-up waits for onDisconnect (user_hangup, onEnded); last words still arrive; page hide and unmount leave it to the SDK", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const onTurn = vi.fn();
    let userEnded = false;
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => userEnded });
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    expect(beats()).toEqual([{ callId: "call-el", state: "connected" }]);
    pageHide();
    call.unmount();
    call.mount();
    await flush();
    userEnded = true;
    call.hangUp();
    expect(h.endSession).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
    sdk.onMessage({ message: "Thanks, bye.", role: "user" });
    expect(onTurn).toHaveBeenLastCalledWith({ role: "user", text: "Thanks, bye." });
    sdk.onDisconnect();
    sdk.onDisconnect();
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(ends()).toEqual([{ callId: "call-el", reason: "user_hangup", keepalive: true }]);
  });

  it("ElevenLabs: a provider error after connect is the connected error, as before", async () => {
    stubFetch(() => mintAnswer("ElevenLabs", "call-el"));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn: vi.fn(), userEnded: () => false });
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    sdk.onError("Voice connection error");
    expect(h.onError).toHaveBeenCalledWith("Voice connection error");
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(ends()).toEqual([{ callId: "call-el", reason: "provider_error", keepalive: true }]);
  });
});

// ---- Free heartbeat loss after connect (callMeter) meets the shared pre-connect cancel (VoiceAttempt) ----------------

describe("a Free call's heartbeat-loss end after connect is the connected end, reported once", () => {
  /**
   * fetch for a Free call: the mint says freeRule, the connect heartbeat answers, every later heartbeat fails (network
   * error), so the meter gives up after MAX_FAILED_HEARTBEATS ticks.
   */
  function stubFreeCall(engine: "Realtime" | "ElevenLabs", callId: string) {
    let heartbeats = 0;
    fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u === "/api/usage/heartbeat") {
        heartbeats += 1;
        if (heartbeats > 1) throw new TypeError("Failed to fetch");
        return Response.json({ stop: false, secondsLeft: 600 });
      }
      if (u.startsWith("/api/usage/")) return Response.json({});
      if (u.endsWith("/sdp")) return Response.json({ sdp: "v=0 answer" });
      return Response.json({ ...(await mintAnswer(engine, callId).json()), freeRule: true });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("Realtime: 3 failed heartbeats end the call once as network_drop; later hang-up, unmount and page hide report nothing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    stubFreeCall("Realtime", "call-rt");
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen!();
    lastPc!.ontrack!({ streams: [{ getTracks: () => [] }] });
    await vi.advanceTimersByTimeAsync(600);
    expect(beats()).toEqual([{ callId: "call-rt", state: "connected" }]);
    // Connected: the attempt's pre-connect page-hide observer is gone.
    expect(pageListeners()).toBe(0);

    await vi.advanceTimersByTimeAsync(MAX_FAILED_HEARTBEATS * 10_000);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith(HEARTBEAT_LOST_MESSAGE);
    expect(lastPc!.closed).toBe(true);
    expect(ends()).toEqual([{ callId: "call-rt", reason: "network_drop", keepalive: true }]);

    // Nothing after it reports again or takes the pre-connect path.
    call.end();
    call.close(true);
    call.close(false);
    pageHide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends()).toHaveLength(1);
    expect(beats()).toHaveLength(1 + MAX_FAILED_HEARTBEATS);
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("ElevenLabs: 3 failed heartbeats end the session once as network_drop; the SDK's onDisconnect then ends the screen without a second report", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    stubFreeCall("ElevenLabs", "call-el");
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    // Wired as TrainerClient's VoiceSession wires it: the handlers depend on the token answer's freeRule.
    const data = await call.mint("/api/elevenlabs/token", (answer) => ({
      ...noop,
      ...(answer.freeRule === true ? { onHeartbeatsLost: () => { call.meter.end("network_drop"); h.endSession(); h.onError(HEARTBEAT_LOST_MESSAGE); } } : {}),
    }));
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn: vi.fn(), userEnded: () => false });
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    await vi.advanceTimersByTimeAsync(0);
    expect(beats()).toEqual([{ callId: "call-el", state: "connected" }]);
    expect(pageListeners()).toBe(0);

    await vi.advanceTimersByTimeAsync(MAX_FAILED_HEARTBEATS * 10_000);
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith(HEARTBEAT_LOST_MESSAGE);
    expect(ends()).toEqual([{ callId: "call-el", reason: "network_drop", keepalive: true }]);

    // The SDK reports the disconnect the endSession caused: the connected path ends the screen, the meter end is a no-op.
    sdk.onDisconnect();
    sdk.onDisconnect();
    call.hangUp();
    pageHide();
    call.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(h.onCancelled).not.toHaveBeenCalled();
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(ends()).toHaveLength(1);
  });
});

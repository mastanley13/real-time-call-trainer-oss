import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallMeter, LEFT_BEFORE_CONNECT_MESSAGE } from "@/lib/callMeter";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { ElevenLabsStart } from "@/components/call/elevenLabsStart";
import { resetSessionExpiryRedirect } from "@/lib/sessionExpiry";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// Every way out of a voice call before it connected must tell the server at once (POST /api/usage/end, failed_connect),
// so the call's reservation is released and the rep can retry. Each path must report exactly once, and nothing from a
// cancelled attempt may resume, including on a page restored from the back/forward cache.

const scenario = BUILT_IN_SCENARIOS[0];
interface FakeDc { readyState: string; onopen?: () => void; close: () => void; send: () => void }
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
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });
const noop = { onStop: () => {}, onGiveUp: () => {} };
const elHandlers = () => ({ onEnded: vi.fn(), onError: vi.fn(), endSession: vi.fn() });
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
const pageShowPersisted = () => page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiryRedirect();
  page = new EventTarget();
  lastPc = null;
  vi.stubGlobal("window", {
    location: { origin: "https://trainer.example.test", pathname: "/trainer", search: "", assign: vi.fn() },
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
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

describe("CallMeter before the first heartbeat", () => {
  it.each(["user_hangup", "network_drop", "provider_error", "server_error", "failed_connect"] as const)("an end with %s is sent once as failed_connect, keepalive", (reason) => {
    const m = new CallMeter("call-1", noop);
    m.end(reason);
    m.end("user_hangup");
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
  });

  it("after the connected heartbeat the reason is sent as given (connected-call billing unchanged)", () => {
    const m = new CallMeter("call-1", noop);
    m.open();
    m.audio();
    m.end("user_hangup");
    expect(beats()).toEqual([{ callId: "call-1", state: "connected" }]);
    expect(ends()).toEqual([{ callId: "call-1", reason: "user_hangup", keepalive: true }]);
  });

  it("leaving the page before the call connected reports failed_connect once and asks the owner to cancel the attempt", () => {
    const onAbandon = vi.fn();
    const m = new CallMeter("call-1", { ...noop, onAbandon });
    page.dispatchEvent(new Event("pagehide"));
    page.dispatchEvent(new Event("pagehide"));
    m.end("user_hangup");
    expect(ends()).toEqual(FAILED_ONCE("call-1"));
    expect(onAbandon).toHaveBeenCalledOnce();
  });

  it("leaving the page after the call connected sends no end from here and cancels nothing", () => {
    const onAbandon = vi.fn();
    const m = new CallMeter("call-1", { ...noop, onAbandon });
    m.open();
    m.audio();
    page.dispatchEvent(new Event("pagehide"));
    expect(ends()).toEqual([]);
    expect(onAbandon).not.toHaveBeenCalled();
    m.end("user_hangup");
  });

  it("a page hide after the meter already ended does nothing", () => {
    const onAbandon = vi.fn();
    const m = new CallMeter("call-1", { ...noop, onAbandon });
    m.end("user_hangup");
    page.dispatchEvent(new Event("pagehide"));
    expect(ends()).toHaveLength(1);
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it("abandon() reports a call that did not connect and leaves a connected one alone", () => {
    const a = new CallMeter("call-a", noop);
    a.abandon();
    const b = new CallMeter("call-b", noop);
    b.open();
    b.audio();
    b.abandon();
    expect(ends()).toEqual(FAILED_ONCE("call-a"));
    b.end("user_hangup");
  });

  it("an ended meter never sends a late connected heartbeat", () => {
    const m = new CallMeter("call-1", noop);
    m.end("failed_connect");
    m.open();
    m.audio();
    expect(beats()).toEqual([]);
  });

  it("without a callId (demo mode) nothing is sent and no page listener is added", () => {
    const add = vi.spyOn(window, "addEventListener");
    const m = new CallMeter(undefined, noop);
    m.end("user_hangup");
    expect(add).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenAI Realtime and GPT-Live: every exit before connect reports failed_connect once", () => {
  const minted = (extra: Record<string, unknown> = {}) => Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-rt", sessionId: "call-rt", ...extra });
  const answered = (url: string) => (url === "/api/realtime/session" ? minted() : Response.json({ sdp: "v=0 answer" }));

  it("hang-up while the mint request is in flight: reported when the callId arrives, and the call never continues", async () => {
    const mint = deferred<Response>();
    stubFetch((url) => (url === "/api/realtime/session" ? mint.promise : Response.json({}, { status: 500 })));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await flush();
    call.end();
    mint.resolve(minted());
    await started;
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(urls()).not.toContain("/api/realtime/sdp");
    expect(h.onMinted).not.toHaveBeenCalled();
  });

  it("unmount while the mint request is in flight reports failed_connect once", async () => {
    const mint = deferred<Response>();
    stubFetch((url) => (url === "/api/realtime/session" ? mint.promise : Response.json({})));
    const call = new RealtimeCall(scenario, handlers());
    const started = call.start();
    await flush();
    call.close(false);
    mint.resolve(minted());
    await started;
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("an SDP error after the mint reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ error: "upstream_error", message: "OpenAI could not connect." }, { status: 502 })));
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("a network failure on the SDP request reports failed_connect once", async () => {
    stubFetch((url) => { if (url === "/api/realtime/sdp") throw new TypeError("network"); return minted(); });
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("a GPT-Live SDP error reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session"
      ? Response.json({ voiceApi: "live", liveTicket: "lt_fictional", callId: "call-rt", sessionId: "call-rt" })
      : Response.json({ error: "realtime_secret_expired" }, { status: 400 })));
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("a secret that expired before connecting reports failed_connect once", async () => {
    stubFetch(() => minted({ expiresAt: 1 }));
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("a peer connection that fails before connecting is reported as failed_connect, once", async () => {
    stubFetch(answered);
    const call = new RealtimeCall(scenario, handlers());
    await call.start();
    expect(ends()).toEqual([]);
    lastPc!.connectionState = "failed";
    lastPc!.onconnectionstatechange!();
    call.close(false);
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("the rep hanging up while connecting reports failed_connect once", async () => {
    stubFetch(answered);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    call.end();
    call.close(false);
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(h.onEnded).toHaveBeenCalledOnce();
  });

  it("unmount while connecting reports failed_connect once", async () => {
    stubFetch(answered);
    const call = new RealtimeCall(scenario, handlers());
    await call.start();
    call.close(false);
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("closing the tab while connecting reports failed_connect once, closes the attempt and returns to the briefing", async () => {
    stubFetch(answered);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    page.dispatchEvent(new Event("pagehide"));
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(lastPc!.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
    expect(h.onEnded).not.toHaveBeenCalled(); // no grading
    call.close(false);
    expect(ends()).toHaveLength(1);
  });

  it("restored page: a page hide during the SDP exchange aborts it, and after pageshow (persisted) nothing resumes", async () => {
    const sdp = deferred<Response>();
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : sdp.promise));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await vi.waitFor(() => expect(urls()).toContain("/api/realtime/sdp"));
    const signal = (fetchMock.mock.calls.find(([u]) => u === "/api/realtime/sdp")![1] as RequestInit).signal!;
    page.dispatchEvent(new Event("pagehide"));
    expect(signal.aborted).toBe(true);
    expect(lastPc!.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);

    // The page comes back from the back/forward cache, and the SDP answer and the provider's events arrive late anyway.
    pageShowPersisted();
    sdp.resolve(Response.json({ sdp: "v=0 answer" }));
    await started;
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen?.();
    lastPc!.ontrack?.({ streams: [{ getTracks: () => [] }] });
    await flush();
    expect(lastPc!.remoteSet).toBe(0);
    expect(beats()).toEqual([]);
    expect(ends()).toHaveLength(1);
    expect(h.onView).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "connected" }));
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("restored page with GPT-Live: a page hide while connecting closes the attempt and a late open is ignored", async () => {
    const sdp = deferred<Response>();
    stubFetch((url) => (url === "/api/realtime/session"
      ? Response.json({ voiceApi: "live", liveTicket: "lt_fictional", callId: "call-rt", sessionId: "call-rt" })
      : sdp.promise));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await vi.waitFor(() => expect(urls()).toContain("/api/live/sdp"));
    page.dispatchEvent(new Event("pagehide"));
    pageShowPersisted();
    sdp.resolve(Response.json({ sdp: "v=0 answer" }));
    await started;
    lastPc!.dc.onopen?.();
    expect(lastPc!.closed).toBe(true);
    expect(lastPc!.remoteSet).toBe(0);
    expect(beats()).toEqual([]);
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
  });

  it("a page hide after the call connected leaves the call running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    stubFetch(answered);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    lastPc!.dc.readyState = "open";
    lastPc!.dc.onopen!();
    lastPc!.ontrack!({ streams: [{ getTracks: () => [] }] });
    await vi.advanceTimersByTimeAsync(600); // the first inbound audio packet is seen
    expect(beats()).toEqual([{ callId: "call-rt", state: "connected" }]);
    page.dispatchEvent(new Event("pagehide"));
    expect(lastPc!.closed).toBe(false);
    expect(ends()).toEqual([]);
    call.close(false);
  });

  it("closing the tab while the mint request is pending: a mint that still arrives is reported once and never continues", async () => {
    const mint = deferred<Response>();
    stubFetch((url) => (url === "/api/realtime/session" ? mint.promise : Response.json({ sdp: "v=0 answer" })));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await flush();
    page.dispatchEvent(new Event("pagehide"));
    mint.resolve(minted());
    await started;
    page.dispatchEvent(new Event("pagehide"));
    call.close(false);
    expect(ends()).toEqual(FAILED_ONCE("call-rt"));
    expect(urls()).not.toContain("/api/realtime/sdp");
    expect(h.onMinted).not.toHaveBeenCalled();
    // Seen only if the page comes back from the back/forward cache: the trainer returns to the briefing with it.
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
  });

  it("a page hide during a mint that then fails: the attempt ended at the page hide, and there is nothing to report", async () => {
    const mint = deferred<Response>();
    stubFetch(() => mint.promise);
    const h = handlers();
    const started = new RealtimeCall(scenario, h).start();
    await flush();
    page.dispatchEvent(new Event("pagehide"));
    mint.resolve(Response.json({ error: "minutes_reserved", message: "Your minutes are held by another call." }, { status: 409 }));
    await started;
    expect(ends()).toEqual([]);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
  });

  it("a page hide during the mic prompt: the stream that arrives is stopped, nothing is minted, and nothing resumes", async () => {
    const stream = deferred<typeof mic>();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => stream.promise) } });
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await flush();
    page.dispatchEvent(new Event("pagehide"));
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
    pageShowPersisted();
    stream.resolve(mic);
    await started;
    expect(track.stop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastPc).toBeNull();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("a hang-up during the mic prompt: the stream that arrives is stopped and nothing is minted", async () => {
    const stream = deferred<typeof mic>();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => stream.promise) } });
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await flush();
    call.end();
    stream.resolve(mic);
    await started;
    expect(track.stop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledOnce();
  });

  it("the pending-mint page listener is removed once the mint answers", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    stubFetch(() => Response.json({ error: "minutes_reserved" }, { status: 409 }));
    await new RealtimeCall(scenario, handlers()).start();
    expect(remove).toHaveBeenCalledWith("pagehide", expect.any(Function));
  });

  it("a mic that is refused never mints, so there is nothing to report", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); }) } });
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
  });
});

describe("ElevenLabs: every exit before connect reports failed_connect once", () => {
  const URL = "/api/elevenlabs/token?scenarioId=x";
  const token = () => Response.json({ token: "tok_fictional_test_only", callId: "call-el" });

  /** A minted attempt whose SDK session was asked for: its callbacks as startSession receives them. */
  async function started(h = elHandlers()) {
    stubFetch(token);
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint(URL, noop);
    const onTurn = vi.fn();
    let userEnded = false;
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => userEnded });
    return { call, sdk, h, onTurn, setUserEnded: () => { userEnded = true; } };
  }

  it("hang-up while the token request is in flight ends the call screen, and the minted call is reported once and never started", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const pending = call.mint(URL, noop);
    await flush();
    call.hangUp();
    call.hangUp();
    expect(h.onEnded).toHaveBeenCalledOnce();
    answer.resolve(token());
    expect(await pending).toBeNull();
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });

  it("unmount while the token request is in flight reports the minted call once", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const pending = call.mint(URL, noop);
    await flush();
    call.unmount();
    answer.resolve(token());
    expect(await pending).toBeNull();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("a StrictMode unmount and remount during the token request does not cancel the call", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const call = new ElevenLabsStart(elHandlers());
    call.mount();
    const pending = call.mint(URL, noop);
    call.unmount();
    call.mount();
    await flush(); // the deferred unmount check finds the component mounted again
    answer.resolve(token());
    expect(await pending).toMatchObject({ token: "tok_fictional_test_only", callId: "call-el", attempt: 1 });
    expect(ends()).toEqual([]);
    expect(call.isCancelled).toBe(false);
    // The real unmount later still cancels it.
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });

  it("hang-up while the SDK is connecting reports failed_connect once and ends the screen at once, with no SDK callback", async () => {
    const { call, h } = await started();
    call.hangUp();
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(call.isCancelled).toBe(true);
  });

  it("after that hang-up, every late callback of the attempt is ignored; a late connect ends that SDK session", async () => {
    const { call, sdk, h, onTurn } = await started();
    call.hangUp();
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    sdk.onMessage({ message: "Hello?", role: "user" });
    sdk.onError("Session failed to start");
    sdk.onDisconnect();
    call.hangUp();
    call.unmount();
    await flush();
    expect(h.endSession).toHaveBeenCalledTimes(2); // the hang-up's cancel, then the late onConnect
    expect(onTurn).not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
    expect(beats()).toEqual([]);
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });

  it("callbacks of an older attempt are ignored once a newer one started", async () => {
    const { call, sdk: first, h, onTurn } = await started();
    const second = await call.mint(URL, noop);
    expect(second!.attempt).toBe(2);
    first.onConnect();
    first.onMessage({ message: "Late line", role: "agent" });
    first.onDisconnect();
    expect(onTurn).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(beats()).toEqual([]);
  });

  it("after onConnect, a hang-up leaves ending the screen to the SDK's onDisconnect, as before", async () => {
    const { call, sdk, h, setUserEnded } = await started();
    sdk.onConnect();
    setUserEnded();
    call.hangUp(); // still before the first agent audio: the meter reports failed_connect now
    expect(h.onEnded).not.toHaveBeenCalled();
    sdk.onDisconnect();
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });

  it("a connected call's hang-up is reported with its own reason through onDisconnect, once", async () => {
    const { call, sdk, h, onTurn, setUserEnded } = await started();
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    expect(onTurn).toHaveBeenCalledWith({ role: "assistant", text: "Hi, this is the buyer." });
    expect(beats()).toEqual([{ callId: "call-el", state: "connected" }]);
    setUserEnded();
    call.hangUp();
    sdk.onDisconnect();
    sdk.onDisconnect();
    expect(h.onEnded).toHaveBeenCalledOnce();
    expect(ends()).toEqual([{ callId: "call-el", reason: "user_hangup", keepalive: true }]);
  });

  it("a provider error before connect is reported as failed_connect once and shown; the disconnect after it ends the screen", async () => {
    const { sdk, h } = await started();
    sdk.onError("Voice connection error");
    sdk.onDisconnect();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.onError).toHaveBeenCalledWith("Voice connection error");
    expect(h.onEnded).toHaveBeenCalledOnce();
  });

  it("closing the tab while the token request is pending: a token that still arrives is reported once and never started", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const pending = call.mint(URL, noop);
    await flush();
    page.dispatchEvent(new Event("pagehide"));
    answer.resolve(token());
    expect(await pending).toBeNull();
    page.dispatchEvent(new Event("pagehide"));
    call.unmount();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    // The page came back (back/forward cache): back to the briefing with the reason, no grading.
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("restored page: a page hide while the SDK is connecting cancels the attempt, and after pageshow (persisted) nothing resumes", async () => {
    const { call, sdk, h, onTurn } = await started();
    page.dispatchEvent(new Event("pagehide"));
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith(LEFT_BEFORE_CONNECT_MESSAGE);
    expect(h.onEnded).not.toHaveBeenCalled(); // no grading
    expect(call.isCancelled).toBe(true);

    pageShowPersisted();
    // The SDK connects late anyway: it is ended again, and nothing reaches the meter or the transcript.
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    sdk.onError("Voice connection error");
    sdk.onDisconnect();
    expect(h.endSession).toHaveBeenCalledTimes(2);
    expect(onTurn).not.toHaveBeenCalled();
    expect(beats()).toEqual([]);
    expect(ends()).toHaveLength(1);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onEnded).not.toHaveBeenCalled();
    // The meter for the attempt stays ended: a direct open and audio cannot restart it either.
    call.meter.open();
    call.meter.audio();
    expect(beats()).toEqual([]);
  });

  it("a page hide after the call connected leaves the call running", async () => {
    const { call, sdk, h } = await started();
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    page.dispatchEvent(new Event("pagehide"));
    expect(h.endSession).not.toHaveBeenCalled();
    expect(ends()).toEqual([]);
    call.meter.end("user_hangup");
  });

  it("a start that fails after the mint is reported once", async () => {
    const { call } = await started();
    call.failed();
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
  });

  it("unmount while the SDK is connecting cancels the attempt: reported once, session ended, every late callback ignored", async () => {
    const { call, sdk, h, onTurn } = await started();
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.endSession).toHaveBeenCalledOnce();
    expect(call.isCancelled).toBe(true);
    // The SDK connects late anyway: that session is ended, and nothing reaches the meter or the transcript.
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    sdk.onMessage({ message: "Hello?", role: "user" });
    sdk.onError("Voice connection error");
    sdk.onDisconnect();
    expect(h.endSession).toHaveBeenCalledTimes(2);
    expect(onTurn).not.toHaveBeenCalled();
    expect(beats()).toEqual([]);
    expect(ends()).toHaveLength(1);
    // An unmounted call has no screen: no screen callback at all.
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("unmount after onConnect but before the first agent audio also cancels the attempt", async () => {
    const { call, sdk, h, onTurn } = await started();
    sdk.onConnect();
    call.unmount();
    await flush();
    expect(ends()).toEqual(FAILED_ONCE("call-el"));
    expect(h.endSession).toHaveBeenCalledOnce();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    expect(onTurn).not.toHaveBeenCalled();
    expect(beats()).toEqual([]);
  });

  it("a failed mint throws and reports nothing: the token route already closed it", async () => {
    stubFetch(() => Response.json({ error: "minutes_reserved", message: "Your minutes are held by another call." }, { status: 409 }));
    const call = new ElevenLabsStart(elHandlers());
    call.mount();
    await expect(call.mint(URL, noop)).rejects.toThrow("Your minutes are held by another call.");
    call.failed();
    call.unmount();
    await flush();
    expect(ends()).toEqual([]);
  });

  it("a connected call is left to its own end event on unmount", async () => {
    const { call, sdk, h } = await started();
    sdk.onConnect();
    sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" });
    call.unmount();
    await flush();
    expect(ends()).toEqual([]);
    expect(h.endSession).not.toHaveBeenCalled();
    sdk.onDisconnect(); // the SDK provider ends the session on unmount
    expect(ends()).toEqual([{ callId: "call-el", reason: "network_drop", keepalive: true }]);
  });
});

describe("the same rules on both engines for every exit before connect", () => {
  type Exit = "hang-up" | "page hide" | "unmount";
  interface Driven {
    exit: (e: Exit) => Promise<void>;
    /** Provider events arriving after the exit (late connect, first audio or message). */
    late: () => Promise<void>;
    onEnded: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    /** The attempt's provider connection was torn down (Realtime peer closed, ElevenLabs session ended). */
    tornDown: () => boolean;
  }

  async function realtime(): Promise<Driven> {
    stubFetch((url) => (url === "/api/realtime/session" ? Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-x", sessionId: "call-x" }) : Response.json({ sdp: "v=0 answer" })));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    return {
      exit: async (e) => { if (e === "hang-up") call.end(); else if (e === "page hide") page.dispatchEvent(new Event("pagehide")); else call.close(false); await flush(); },
      late: async () => { lastPc!.dc.readyState = "open"; lastPc!.dc.onopen?.(); lastPc!.ontrack?.({ streams: [{ getTracks: () => [] }] }); await flush(); },
      onEnded: h.onEnded, onError: h.onError,
      tornDown: () => lastPc!.closed,
    };
  }

  async function elevenLabs(): Promise<Driven> {
    stubFetch(() => Response.json({ token: "tok_fictional_test_only", callId: "call-x" }));
    const h = elHandlers();
    const call = new ElevenLabsStart(h);
    call.mount();
    const data = await call.mint("/api/elevenlabs/token", noop);
    const onTurn = vi.fn();
    const sdk = call.sessionCallbacks(data!.attempt, { onTurn, userEnded: () => false });
    return {
      exit: async (e) => { if (e === "hang-up") call.hangUp(); else if (e === "page hide") page.dispatchEvent(new Event("pagehide")); else call.unmount(); await flush(); },
      late: async () => { sdk.onConnect(); sdk.onMessage({ message: "Hi, this is the buyer.", role: "agent" }); await flush(); expect(onTurn).not.toHaveBeenCalled(); },
      onEnded: h.onEnded, onError: h.onError,
      tornDown: () => h.endSession.mock.calls.length > 0,
    };
  }

  const screen: Record<Exit, { ended: number; error: string | null }> = {
    "hang-up": { ended: 1, error: null }, // back to the briefing: nothing said, nothing to grade
    "page hide": { ended: 0, error: LEFT_BEFORE_CONNECT_MESSAGE }, // back to the briefing with the reason, no grading
    unmount: { ended: 0, error: null }, // no screen left to update
  };

  for (const [engine, drive] of [["Realtime", realtime], ["ElevenLabs", elevenLabs]] as const) {
    for (const exit of ["hang-up", "page hide", "unmount"] as const) {
      it(`${engine}, ${exit} while connecting: failed_connect once, connection torn down, same screen result, nothing resumes`, async () => {
        const d = await drive();
        await d.exit(exit);
        expect(ends()).toEqual(FAILED_ONCE("call-x"));
        expect(d.tornDown()).toBe(true);
        expect(d.onEnded).toHaveBeenCalledTimes(screen[exit].ended);
        if (screen[exit].error) expect(d.onError).toHaveBeenCalledWith(screen[exit].error);
        else expect(d.onError).not.toHaveBeenCalled();
        pageShowPersisted();
        await d.late();
        expect(beats()).toEqual([]);
        expect(ends()).toHaveLength(1);
        expect(d.onEnded).toHaveBeenCalledTimes(screen[exit].ended);
        expect(d.onError).toHaveBeenCalledTimes(screen[exit].error ? 1 : 0);
      });
    }
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallMeter } from "@/lib/callMeter";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { ElevenLabsStart } from "@/components/call/elevenLabsStart";
import { resetSessionExpiryRedirect } from "@/lib/sessionExpiry";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// Every way out of a voice call before it connected must tell the server at once (POST /api/usage/end, failed_connect),
// so the call's reservation is released and the rep can retry. Each path must report exactly once.

const scenario = BUILT_IN_SCENARIOS[0];
let page: EventTarget;
let fetchMock: ReturnType<typeof vi.fn>;
let lastPc: { onconnectionstatechange?: () => void; connectionState: string } | null;
const track = { enabled: true, stop: vi.fn() };
const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });
const noop = { onStop: () => {}, onGiveUp: () => {} };

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;
/** fetch stub: /api/usage/* answers 200; anything else goes to `route`. */
function stubFetch(route: Route = () => Response.json({})) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => (String(url).startsWith("/api/usage/") ? Response.json({}) : route(String(url), init)));
  vi.stubGlobal("fetch", fetchMock);
}
const posted = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => ({ ...JSON.parse(String((init as RequestInit).body)), keepalive: (init as RequestInit).keepalive }));
const ends = () => posted("/api/usage/end");
const beats = () => posted("/api/usage/heartbeat");
const flush = () => new Promise((r) => setTimeout(r, 0));
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
  vi.stubGlobal("Audio", class { autoplay = false; srcObject = null; pause() {} });
  vi.stubGlobal("RTCPeerConnection", class {
    connectionState = "new";
    onconnectionstatechange?: () => void;
    constructor() { lastPc = this; }
    addTrack() {}
    createDataChannel() { return { readyState: "connecting", close() {} }; }
    async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  });
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("CallMeter before the first heartbeat", () => {
  it.each(["user_hangup", "network_drop", "provider_error", "server_error", "failed_connect"] as const)("an end with %s is sent once as failed_connect, keepalive", (reason) => {
    const m = new CallMeter("call-1", noop);
    m.end(reason);
    m.end("user_hangup");
    expect(ends()).toEqual([{ callId: "call-1", reason: "failed_connect", keepalive: true }]);
  });

  it("after the connected heartbeat the reason is sent as given (connected-call billing unchanged)", () => {
    const m = new CallMeter("call-1", noop);
    m.open();
    m.audio();
    m.end("user_hangup");
    expect(beats()).toEqual([{ callId: "call-1", state: "connected" }]);
    expect(ends()).toEqual([{ callId: "call-1", reason: "user_hangup", keepalive: true }]);
  });

  it("leaving the page before the call connected reports failed_connect once", () => {
    const m = new CallMeter("call-1", noop);
    page.dispatchEvent(new Event("pagehide"));
    page.dispatchEvent(new Event("pagehide"));
    m.end("user_hangup");
    expect(ends()).toEqual([{ callId: "call-1", reason: "failed_connect", keepalive: true }]);
  });

  it("leaving the page after the call connected sends no end from here", () => {
    const m = new CallMeter("call-1", noop);
    m.open();
    m.audio();
    page.dispatchEvent(new Event("pagehide"));
    expect(ends()).toEqual([]);
    m.end("user_hangup");
  });

  it("abandon() reports a call that did not connect and leaves a connected one alone", () => {
    const a = new CallMeter("call-a", noop);
    a.abandon();
    const b = new CallMeter("call-b", noop);
    b.open();
    b.audio();
    b.abandon();
    expect(ends()).toEqual([{ callId: "call-a", reason: "failed_connect", keepalive: true }]);
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
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain("/api/realtime/sdp");
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
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("an SDP error after the mint reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ error: "upstream_error", message: "OpenAI could not connect." }, { status: 502 })));
    const h = handlers();
    await new RealtimeCall(scenario, h).start();
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("a network failure on the SDP request reports failed_connect once", async () => {
    stubFetch((url) => { if (url === "/api/realtime/sdp") throw new TypeError("network"); return minted(); });
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("a GPT-Live SDP error reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session"
      ? Response.json({ voiceApi: "live", liveTicket: "lt_fictional", callId: "call-rt", sessionId: "call-rt" })
      : Response.json({ error: "realtime_secret_expired" }, { status: 400 })));
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      localDescription = { sdp: "v=0 test offer" };
      addTrack() {}
      createDataChannel() { return { readyState: "connecting", close() {} }; }
      async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
      async setLocalDescription() {}
      close() {}
    });
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("a secret that expired before connecting reports failed_connect once", async () => {
    stubFetch(() => minted({ expiresAt: 1 }));
    await new RealtimeCall(scenario, handlers()).start();
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("a peer connection that fails before connecting is reported as failed_connect, once", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ sdp: "v=0 answer" })));
    const call = new RealtimeCall(scenario, handlers());
    await call.start();
    expect(ends()).toEqual([]);
    lastPc!.connectionState = "failed";
    lastPc!.onconnectionstatechange!();
    call.close(false);
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("the rep hanging up while connecting reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ sdp: "v=0 answer" })));
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    await call.start();
    call.end();
    call.close(false);
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
    expect(h.onEnded).toHaveBeenCalledOnce();
  });

  it("unmount while connecting reports failed_connect once", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ sdp: "v=0 answer" })));
    const call = new RealtimeCall(scenario, handlers());
    await call.start();
    call.close(false);
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
  });

  it("closing the tab while connecting reports failed_connect once, and a later close sends nothing more", async () => {
    stubFetch((url) => (url === "/api/realtime/session" ? minted() : Response.json({ sdp: "v=0 answer" })));
    const call = new RealtimeCall(scenario, handlers());
    await call.start();
    page.dispatchEvent(new Event("pagehide"));
    call.close(false);
    expect(ends()).toEqual([{ callId: "call-rt", reason: "failed_connect", keepalive: true }]);
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

  it("hang-up while the token request is in flight ends the call screen, and the minted call is reported once and never started", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const onEnded = vi.fn();
    const call = new ElevenLabsStart({ onEnded });
    call.mount();
    const pending = call.mint(URL, noop);
    await flush();
    call.hangUp();
    call.hangUp();
    expect(onEnded).toHaveBeenCalledOnce();
    answer.resolve(token());
    expect(await pending).toBeNull();
    call.unmount();
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
  });

  it("unmount while the token request is in flight reports the minted call once", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const onEnded = vi.fn();
    const call = new ElevenLabsStart({ onEnded });
    call.mount();
    const pending = call.mint(URL, noop);
    await flush();
    call.unmount();
    answer.resolve(token());
    expect(await pending).toBeNull();
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("a StrictMode unmount and remount during the token request does not cancel the call", async () => {
    const answer = deferred<Response>();
    stubFetch(() => answer.promise);
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    const pending = call.mint(URL, noop);
    call.unmount();
    call.mount();
    answer.resolve(token());
    expect(await pending).toMatchObject({ token: "tok_fictional_test_only", callId: "call-el" });
    expect(ends()).toEqual([]);
    call.unmount();
  });

  it("hang-up while the SDK is connecting reports failed_connect once, even if onDisconnect follows", async () => {
    stubFetch(token);
    const onEnded = vi.fn();
    const call = new ElevenLabsStart({ onEnded });
    call.mount();
    await call.mint(URL, noop);
    call.hangUp();
    call.meter.end("user_hangup"); // the SDK's onDisconnect, if it comes
    call.unmount();
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
    expect(onEnded).not.toHaveBeenCalled(); // the SDK's onDisconnect ends the screen for a started session
  });

  it("a provider error before connect is reported as failed_connect once", async () => {
    stubFetch(token);
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    await call.mint(URL, noop);
    call.meter.end("provider_error"); // useConversation onError
    call.meter.end("network_drop"); // and onDisconnect
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
  });

  it("a start that fails after the mint is reported once", async () => {
    stubFetch(token);
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    await call.mint(URL, noop);
    call.failed();
    call.unmount();
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
  });

  it("unmount or closing the tab while connecting reports failed_connect once", async () => {
    stubFetch(token);
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    await call.mint(URL, noop);
    page.dispatchEvent(new Event("pagehide"));
    call.unmount();
    expect(ends()).toEqual([{ callId: "call-el", reason: "failed_connect", keepalive: true }]);
  });

  it("a failed mint throws and reports nothing: the token route already closed it", async () => {
    stubFetch(() => Response.json({ error: "minutes_reserved", message: "Your minutes are held by another call." }, { status: 409 }));
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    await expect(call.mint(URL, noop)).rejects.toThrow("Your minutes are held by another call.");
    call.failed();
    call.unmount();
    expect(ends()).toEqual([]);
  });

  it("a connected call is left to its own end event on unmount", async () => {
    stubFetch(token);
    const call = new ElevenLabsStart({ onEnded: vi.fn() });
    call.mount();
    await call.mint(URL, noop);
    call.meter.open();
    call.meter.audio();
    call.unmount();
    expect(ends()).toEqual([]);
    call.meter.end("user_hangup");
    expect(ends()).toEqual([{ callId: "call-el", reason: "user_hangup", keepalive: true }]);
  });
});

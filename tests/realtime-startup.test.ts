import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { CONNECT_TIMEOUT_MESSAGE, CONNECT_TIMEOUT_MS } from "@/lib/callStatus";

const scenario = BUILT_IN_SCENARIOS[0];
const stop = vi.fn();
const assign = vi.fn();
const closePeer = vi.fn();
const closeChannel = vi.fn();
const removeItem = vi.fn();
const track = { enabled: true, stop };
const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("localStorage", { removeItem });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => mic) } });
  // Volume meters are optional; no audio device or live media is used in tests.
  vi.stubGlobal("AudioContext", class { constructor() { throw new Error("No audio device in test"); } });
  vi.stubGlobal("Audio", class { autoplay = false; srcObject = null; pause() {} });
  vi.stubGlobal("RTCPeerConnection", class {
    addTrack() {}
    createDataChannel() { return { readyState: "connecting", close: closeChannel }; }
    async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
    async setLocalDescription() {}
    close = closePeer;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("voice startup session recovery", () => {
  it.each([
    ["Invalid or expired session", "/login"],
    ["Authentication required", "/login"],
    ["access_code_required", "/access"],
  ])("recovers %s and stops the microphone before navigation", async (error, destination) => {
    const h = handlers();
    const fetchMock = vi.fn(async () => Response.json({ error }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    assign.mockImplementation(() => {
      expect(stop).toHaveBeenCalledOnce();
      if (destination === "/login") {
        expect(removeItem).toHaveBeenCalledWith("authToken");
        expect(removeItem).toHaveBeenCalledWith("userData");
      } else {
        expect(removeItem).not.toHaveBeenCalled();
      }
    });
    await new RealtimeCall(scenario, h).start();
    expect(assign).toHaveBeenCalledWith(destination);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("recovers when the app session expires during the SDP exchange", async () => {
    const h = handlers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ clientSecret: "ek_fictional_test_only" }))
      .mockResolvedValueOnce(Response.json({ error: "Invalid or expired session" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await new RealtimeCall(scenario, h).start();
    expect(assign).toHaveBeenCalledWith("/login");
    expect(closePeer).toHaveBeenCalledOnce();
    expect(closeChannel).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("does not redirect a call that was already cancelled while the request was pending", async () => {
    let reply!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { reply = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall(scenario, handlers());
    const started = call.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    call.close(false);
    reply(Response.json({ error: "Invalid or expired session" }, { status: 401 }));
    await started;
    expect(assign).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps provider failures on the trainer instead of sending the user to sign in", async () => {
    const h = handlers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "realtime_upstream_error", message: "Voice is temporarily unavailable." }, { status: 502 })));
    await new RealtimeCall(scenario, h).start();
    expect(assign).not.toHaveBeenCalled();
    // A mint failure happens before connect, so it is flagged as a connect failure (the trainer returns to the briefing).
    expect(h.onError).toHaveBeenCalledWith("Voice is temporarily unavailable.", { connectFailed: true });
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("connect timeout and late answers (SAL-1039)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("times out a mic that never answers as a flagged connect failure, without grading", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => new Promise(() => {})) } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = handlers();
    void new RealtimeCall(scenario, h).start();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(h.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.onError).toHaveBeenCalledWith(CONNECT_TIMEOUT_MESSAGE, { connectFailed: true });
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles a mint that lands after the call closed as failed_connect, and goes no further", async () => {
    let reply!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { reply = resolve; }))
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall(scenario, handlers());
    const started = call.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    call.close(false);
    reply(Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-late-mint" }));
    await started;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/usage/end");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ callId: "call-late-mint", reason: "failed_connect" });
  });

  it("sends no SDP offer when the call closes while createOffer is pending", async () => {
    let offered!: (o: RTCSessionDescriptionInit) => void;
    const setLocal = vi.fn(async () => {});
    vi.stubGlobal("RTCPeerConnection", class {
      addTrack() {}
      createDataChannel() { return { readyState: "connecting", close: closeChannel }; }
      createOffer() { return new Promise<RTCSessionDescriptionInit>((resolve) => { offered = resolve; }); }
      setLocalDescription = setLocal;
      close = closePeer;
    });
    const fetchMock = vi.fn(async () => Response.json({ clientSecret: "ek_fictional_test_only" }));
    vi.stubGlobal("fetch", fetchMock);
    const call = new RealtimeCall(scenario, handlers());
    const started = call.start();
    await vi.waitFor(() => expect(offered).toBeTypeOf("function"));
    call.close(false);
    offered({ type: "offer", sdp: "v=0 test offer" });
    await started;
    expect(setLocal).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce(); // the mint only; no /api/realtime/sdp
  });
});

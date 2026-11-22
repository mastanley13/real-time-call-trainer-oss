import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

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
    expect(h.onError).toHaveBeenCalledWith("Voice is temporarily unavailable.");
    expect(stop).toHaveBeenCalledOnce();
  });
});

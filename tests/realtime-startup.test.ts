import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { resetSessionExpiryRedirect } from "@/lib/sessionExpiry";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const scenario = BUILT_IN_SCENARIOS[0];
const stop = vi.fn();
const assign = vi.fn();
const closePeer = vi.fn();
const closeChannel = vi.fn();
const removeItem = vi.fn();
const getItem = vi.fn((k: string) => (k === "authToken" ? "header.payload.signature" : null));
const track = { enabled: true, stop };
const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });
const LOGIN_EXPIRED = `/login?next=${encodeURIComponent("/trainer?scenario=x")}&reason=expired`;

function stubMedia() {
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
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiryRedirect();
  vi.stubGlobal("window", { location: { origin: "https://trainer.example.test", pathname: "/trainer", search: "?scenario=x", assign } });
  vi.stubGlobal("localStorage", { getItem, removeItem });
  stubMedia();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("voice startup session recovery", () => {
  it.each([
    ["Invalid or expired session", LOGIN_EXPIRED],
    ["Authentication required", LOGIN_EXPIRED],
    ["access_code_required", "/access"],
  ])("recovers %s and stops the microphone before navigation", async (error, destination) => {
    const h = handlers();
    const fetchMock = vi.fn(async () => Response.json({ error }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    assign.mockImplementation(() => {
      expect(stop).toHaveBeenCalledOnce();
      if (destination === LOGIN_EXPIRED) {
        expect(removeItem).toHaveBeenCalledWith("authToken");
        expect(removeItem).toHaveBeenCalledWith("userData");
      } else {
        expect(removeItem).not.toHaveBeenCalled();
      }
    });
    await new RealtimeCall(scenario, h).start();
    expect(assign).toHaveBeenCalledOnce();
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
    expect(assign).toHaveBeenCalledWith(LOGIN_EXPIRED);
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

describe("voice 401 handoff to the installed session guard", () => {
  /** A browser-like page: AuthContext installs the guard on window.fetch, and the call's global fetch is that same function. */
  async function page(respond: () => Promise<Response>) {
    const store = new Map([["authToken", "header.payload.signature"], ["userData", "{}"]]);
    const pageAssign = vi.fn();
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respond());
    const win = { fetch: inner as unknown as typeof fetch, location: { origin: "https://trainer.example.test", pathname: "/trainer", search: "?scenario=x", assign: pageAssign } };
    vi.stubGlobal("window", win);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    stubMedia();
    vi.resetModules();
    await import("@/contexts/AuthContext");
    const { RealtimeCall: Call } = await import("@/components/call/RealtimeVoiceSession");
    expect(win.fetch).not.toBe(inner);
    vi.stubGlobal("fetch", win.fetch);
    return { store, pageAssign, inner, Call };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  afterEach(() => vi.resetModules());

  it("navigates once, to /login with a safe next and reason=expired, when both the guard and the call see the 401", async () => {
    const { store, pageAssign, inner, Call } = await page(async () => Response.json({ error: "Invalid or expired session" }, { status: 401 }));
    const h = handlers();
    await new Call(scenario, h).start();
    await settle();
    expect(inner).toHaveBeenCalledOnce();
    expect(pageAssign).toHaveBeenCalledOnce();
    expect(pageAssign).toHaveBeenCalledWith(LOGIN_EXPIRED);
    expect(store.has("authToken")).toBe(false);
    expect(store.has("userData")).toBe(false);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("leaves a newer session alone when a delayed voice 401 lands after the user signed in again", async () => {
    let reply!: (r: Response) => void;
    const { store, pageAssign, inner, Call } = await page(() => new Promise<Response>((r) => { reply = r; }));
    const h = handlers();
    const started = new Call(scenario, h).start();
    await vi.waitFor(() => expect(inner).toHaveBeenCalledOnce());
    store.set("authToken", "header.new-payload.signature");
    reply(Response.json({ error: "Invalid or expired session" }, { status: 401 }));
    await started;
    await settle();
    expect(pageAssign).not.toHaveBeenCalled();
    expect(store.get("authToken")).toBe("header.new-payload.signature");
    expect(store.has("userData")).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith("Could not start the voice call. Try again, or switch to Text.");
  });
});

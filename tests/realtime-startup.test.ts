import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeCall } from "@/components/call/RealtimeVoiceSession";
import { resetSessionExpiryRedirect } from "@/lib/sessionExpiry";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { CONNECT_TIMEOUT_MESSAGE, CONNECT_TIMEOUT_MS } from "@/lib/callStatus";

const scenario = BUILT_IN_SCENARIOS[0];
const stop = vi.fn();
const assign = vi.fn();
const closePeer = vi.fn();
const closeChannel = vi.fn();
const removeItem = vi.fn();
const getItem = vi.fn((k: string) => (k === "authToken" ? "header.payload.signature" : null));
const track = { enabled: true, stop };
const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
const handlers = () => ({ onTurn: vi.fn(), onEnded: vi.fn(), onCancelled: vi.fn(), onError: vi.fn(), onView: vi.fn(), onMinted: vi.fn(), onVoiceInfo: vi.fn() });
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

  it.each([
    ["an unrelated 401 at session start", () => vi.fn(async () => Response.json({ error: "voice_not_allowed" }, { status: 401 }))],
    ["a malformed 401 at session start", () => vi.fn(async () => new Response("<html>401</html>", { status: 401 }))],
    ["an unrelated 401 during the SDP exchange", () => vi.fn()
      .mockResolvedValueOnce(Response.json({ clientSecret: "ek_fictional_test_only" }))
      .mockResolvedValueOnce(Response.json({ error: "voice_not_allowed" }, { status: 401 }))],
    ["an unrelated 401 during the Live SDP exchange", () => vi.fn()
      .mockResolvedValueOnce(Response.json({ voiceApi: "live", liveTicket: "lt_fictional_test_only", sessionId: "s1" }))
      .mockResolvedValueOnce(Response.json({ error: "voice_not_allowed" }, { status: 401 }))],
  ])("treats %s as an ordinary failure: no sign-out, no redirect", async (_label, makeFetch) => {
    vi.stubGlobal("RTCPeerConnection", class {
      iceGatheringState = "complete";
      addTrack() {}
      createDataChannel() { return { readyState: "connecting", close: closeChannel }; }
      async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
      async setLocalDescription() {}
      localDescription = { sdp: "v=0 test offer" };
      close = closePeer;
    });
    const h = handlers();
    const fetchMock = makeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await new RealtimeCall(scenario, h).start();
    // Each case reached the request that answered 401: the mint, then /api/realtime/sdp or /api/live/sdp.
    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(urls[urls.length - 1]).toBe(_label.includes("Live") ? "/api/live/sdp" : _label.includes("SDP") ? "/api/realtime/sdp" : "/api/realtime/session");
    expect(assign).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalledWith(expect.stringMatching(/sign in/i));
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

  it("a hang-up while waiting for the mic cancels without grading or an error", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => new Promise(() => {})) } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    void call.start();
    call.end();
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onView).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "closed" }));
    // A second press, or a later failure, does nothing more.
    call.end();
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a hang-up after the mint but before connect settles the call as failed_connect and never grades", async () => {
    let offered!: (o: RTCSessionDescriptionInit) => void;
    vi.stubGlobal("RTCPeerConnection", class {
      addTrack() {}
      createDataChannel() { return { readyState: "connecting", close: closeChannel }; }
      createOffer() { return new Promise<RTCSessionDescriptionInit>((resolve) => { offered = resolve; }); }
      async setLocalDescription() {}
      close = closePeer;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ clientSecret: "ek_fictional_test_only", callId: "call-hangup-early" }))
      .mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const h = handlers();
    const call = new RealtimeCall(scenario, h);
    const started = call.start();
    await vi.waitFor(() => expect(offered).toBeTypeOf("function"));
    call.end();
    offered({ type: "offer", sdp: "v=0 test offer" });
    await started;
    expect(h.onCancelled).toHaveBeenCalledOnce();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/usage/end");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ callId: "call-hangup-early", reason: "failed_connect" });
    expect(stop).toHaveBeenCalledOnce();
    expect(closePeer).toHaveBeenCalledOnce();
  });

  describe("an SDP request in flight when the attempt closes (Codex re-review)", () => {
    const setRemote = vi.fn(async () => {});
    beforeEach(() => {
      setRemote.mockClear();
      vi.stubGlobal("RTCPeerConnection", class {
        iceGatheringState = "complete";
        localDescription = { type: "offer", sdp: "v=0 gathered offer" };
        addTrack() {}
        createDataChannel() { return { readyState: "connecting", close: closeChannel }; }
        async createOffer() { return { type: "offer", sdp: "v=0 test offer" }; }
        async setLocalDescription() {}
        setRemoteDescription = setRemote;
        close = closePeer;
      });
    });

    const LIVE_MINT = { voiceApi: "live", liveTicket: "lt_fictional_test_only", sessionId: "sess-fictional-01", callId: "call-live-sdp" };
    const REALTIME_MINT = { clientSecret: "ek_fictional_test_only", callId: "call-live-sdp" };

    /** The mint answers at once; the SDP request stays pending and records its abort signal. Later calls (usage end) answer {}. */
    function pendingSdp(mint: object) {
      const sdp: { signal?: AbortSignal; answer?: (r: Response) => void; url?: string } = {};
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/realtime/session") return Response.json(mint);
        if (url.endsWith("/sdp")) {
          sdp.url = url;
          sdp.signal = init?.signal ?? undefined;
          return new Promise<Response>((resolve, reject) => {
            sdp.answer = resolve;
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        return new Response("{}");
      });
      vi.stubGlobal("fetch", fetchMock);
      return { sdp, fetchMock };
    }
    const usageEnds = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.filter((c) => c[0] === "/api/usage/end").map((c) => JSON.parse((c[1] as RequestInit).body as string));

    it.each([["GPT-Live", LIVE_MINT, "/api/live/sdp"], ["Realtime", REALTIME_MINT, "/api/realtime/sdp"]])(
      "%s: a hang-up aborts the SDP request, settles failed_connect and cancels without grading",
      async (_name, mint, url) => {
        const { sdp, fetchMock } = pendingSdp(mint);
        const h = handlers();
        const call = new RealtimeCall(scenario, h);
        const started = call.start();
        await vi.waitFor(() => expect(sdp.signal).toBeDefined());
        expect(sdp.url).toBe(url);
        expect(sdp.signal!.aborted).toBe(false);
        call.end();
        expect(sdp.signal!.aborted).toBe(true);
        await started;
        expect(h.onCancelled).toHaveBeenCalledOnce();
        expect(h.onEnded).not.toHaveBeenCalled();
        expect(h.onError).not.toHaveBeenCalled();
        expect(usageEnds(fetchMock)).toEqual([{ callId: "call-live-sdp", reason: "failed_connect" }]);
        expect(setRemote).not.toHaveBeenCalled();
        expect(closePeer).toHaveBeenCalled();
        expect(stop).toHaveBeenCalled();
      },
    );

    it("the connect timeout aborts a GPT-Live SDP request in flight and reports the timeout once", async () => {
      vi.useFakeTimers();
      const { sdp, fetchMock } = pendingSdp(LIVE_MINT);
      const h = handlers();
      const started = new RealtimeCall(scenario, h).start();
      await vi.advanceTimersByTimeAsync(100);
      expect(sdp.signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      await started;
      expect(sdp.signal!.aborted).toBe(true);
      expect(h.onError).toHaveBeenCalledOnce();
      expect(h.onError).toHaveBeenCalledWith(CONNECT_TIMEOUT_MESSAGE, { connectFailed: true });
      expect(h.onEnded).not.toHaveBeenCalled();
      expect(usageEnds(fetchMock)).toEqual([{ callId: "call-live-sdp", reason: "failed_connect" }]);
      expect(setRemote).not.toHaveBeenCalled();
      expect(closePeer).toHaveBeenCalled();
    });

    it("an unmount aborts a GPT-Live SDP request in flight without grading", async () => {
      const { sdp } = pendingSdp(LIVE_MINT);
      const h = handlers();
      const call = new RealtimeCall(scenario, h);
      const started = call.start();
      await vi.waitFor(() => expect(sdp.signal).toBeDefined());
      call.close(false);
      expect(sdp.signal!.aborted).toBe(true);
      await started;
      expect(h.onEnded).not.toHaveBeenCalled();
      expect(h.onError).not.toHaveBeenCalled();
      expect(setRemote).not.toHaveBeenCalled();
    });

    it("an answer that arrives after close anyway is never applied, and the peer connection and mic stay torn down", async () => {
      // A fetch that cannot be aborted (the request already completed on the wire) still answers late.
      let answer!: (r: Response) => void;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "/api/realtime/session") return Response.json(LIVE_MINT);
        if (url === "/api/live/sdp") return new Promise<Response>((resolve) => { answer = resolve; });
        return new Response("{}");
      });
      vi.stubGlobal("fetch", fetchMock);
      const h = handlers();
      const call = new RealtimeCall(scenario, h);
      const started = call.start();
      await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
      call.end();
      const closesAtHangUp = closePeer.mock.calls.length;
      const stopsAtHangUp = stop.mock.calls.length;
      answer(Response.json({ sdp: "v=0 late answer" }));
      await started;
      expect(setRemote).not.toHaveBeenCalled();
      expect(closePeer.mock.calls.length).toBeGreaterThan(closesAtHangUp);
      expect(stop.mock.calls.length).toBeGreaterThan(stopsAtHangUp);
      expect(h.onCancelled).toHaveBeenCalledOnce();
      expect(h.onEnded).not.toHaveBeenCalled();
      expect(h.onError).not.toHaveBeenCalled();
    });
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
    // A pre-connect failure on this branch always carries the flag, so the trainer returns to the briefing.
    expect(h.onError).toHaveBeenCalledWith("Could not start the voice call. Try again, or switch to Text.", { connectFailed: true });
    expect(h.onEnded).not.toHaveBeenCalled();
  });
});

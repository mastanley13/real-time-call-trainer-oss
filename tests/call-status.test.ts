import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MESSAGE, CONNECT_TIMEOUT_MS, VoiceAttempts, callClockSeconds, elevenLabsConnectTimeout, elevenLabsHangUp, elevenLabsPhase, leavesCallOnError, settleAbandonedCall, voiceStatusCopy, type VoicePhase } from "@/lib/callStatus";
import { CallMeter } from "@/lib/callMeter";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** U+2014, built from its code so this file holds no literal em dash. */
const EM_DASH = String.fromCharCode(0x2014);
const PHASES: VoicePhase[] = ["mic", "connecting", "connected", "ending", "closed"];
const LIVE = "Mic is live. Just talk; the transcript and coach follow along.";

describe("voiceStatusCopy (SAL-1039)", () => {
  it("says the mic is live only once the call is connected and unmuted", () => {
    for (const phase of PHASES) {
      for (const muted of [false, true]) {
        const c = voiceStatusCopy(phase, muted);
        expect(c.connected).toBe(phase === "connected");
        expect(c.footer.label === LIVE).toBe(phase === "connected" && !muted);
        expect(c.body.includes("Say hello")).toBe(phase === "connected");
      }
    }
  });

  it("waits for the mic in every place at once", () => {
    const c = voiceStatusCopy("mic", false);
    expect(c.header).toEqual({ label: "Waiting for your mic…", tone: "caution" });
    expect(c.body).toBe("Connecting the call…");
    expect(c.footer.label).toMatch(/^Waiting for your mic\./);
    expect(c.footer.tone).toBe("caution");
  });

  it("shows one connecting state until connected", () => {
    const c = voiceStatusCopy("connecting", false);
    expect(c.header).toEqual({ label: "Connecting…", tone: "caution" });
    expect(c.body).toBe("Connecting the call…");
    expect(c.footer).toEqual({ label: "Connecting the call. Your mic goes live once it connects.", tone: "caution" });
    expect(voiceStatusCopy("connecting", true).footer.label).toMatch(/Your mic is muted\.$/);
  });

  it("covers connected: your turn, speaking, muted", () => {
    expect(voiceStatusCopy("connected", false)).toMatchObject({ header: { label: "Your turn", tone: "ok" }, footer: { label: LIVE, tone: "ok" } });
    expect(voiceStatusCopy("connected", false, { speaking: true, name: "Dana" }).header).toEqual({ label: "Dana is speaking", tone: "signal" });
    expect(voiceStatusCopy("connected", true, { speaking: true, name: "Dana" })).toMatchObject({ header: { label: "Muted", tone: "caution" }, footer: { label: "Your mic is muted.", tone: "alert" } });
  });

  it("covers ending and closed", () => {
    expect(voiceStatusCopy("ending", false).header).toEqual({ label: "Wrapping up…", tone: "signal" });
    expect(voiceStatusCopy("closed", false).header).toEqual({ label: "Call ended", tone: "caution" });
    expect(voiceStatusCopy("closed", false).footer.tone).toBe("off");
  });

  it("uses no em dashes in any copy", () => {
    for (const phase of PHASES) for (const muted of [false, true]) expect(JSON.stringify(voiceStatusCopy(phase, muted))).not.toContain(EM_DASH);
    expect(CONNECT_TIMEOUT_MESSAGE).not.toContain(EM_DASH);
  });

  it("the changed files hold no em dashes", () => {
    for (const p of ["src/lib/callStatus.ts", "src/components/call/Deck.tsx", "src/components/call/Briefing.tsx", "src/components/call/RealtimeVoiceSession.tsx", "src/components/TrainerClient.tsx", "tests/call-status.test.ts"]) {
      expect(src(p), p).not.toContain(EM_DASH);
    }
  });
});

describe("header, body and footer share voiceStatusCopy", () => {
  const deck = src("src/components/call/Deck.tsx");
  const realtime = src("src/components/call/RealtimeVoiceSession.tsx");
  const trainer = src("src/components/TrainerClient.tsx");

  it("Deck derives the body and footer from the voice phase", () => {
    expect(deck).toContain("voiceStatusCopy(voice.phase, voice.muted)");
    expect(deck).toContain("voiceCopy.body");
    expect(deck).toContain("voiceCopy.footer.label");
    expect(deck).not.toContain("Connecting the call. Say hello");
    expect(deck).not.toContain(LIVE);
  });

  it("both voice engines build the header from it and pass the phase to the deck", () => {
    expect(realtime).toMatch(/voiceStatusCopy\(view\.phase, view\.muted/);
    expect(realtime).toContain("phase: view.phase");
    expect(trainer).toMatch(/voiceStatusCopy\(phase, isMuted/);
    expect(trainer).toContain("phase: v.phase");
    expect(realtime).not.toContain("Allow the mic to connect");
  });

  it("starts the voice call clock at 0:00 on connect", () => {
    expect(deck).toMatch(/if \(voice\?\.phase === "connected" && connectedAt === null\) setConnectedAt\(elapsed\)/);
    expect(deck).toContain("callClockSeconds(elapsed, connectedAt)");
    expect(deck).toContain("formatDuration(shownElapsed)");
    expect(deck).toContain("clock(t.timestamp, clockStart)");
  });
});

describe("elevenLabsPhase (round 6)", () => {
  const before = { grading: false, wasConnected: false };
  const after = { grading: false, wasConnected: true };

  it("is connecting only before the first connect", () => {
    for (const s of ["connecting", "disconnected", "error"]) expect(elevenLabsPhase(s, before)).toBe("connecting");
    expect(elevenLabsPhase("connected", before)).toBe("connected");
  });

  it("matches Realtime after the call: ending while hanging up, closed once ended or grading", () => {
    expect(elevenLabsPhase("disconnecting", after)).toBe("ending");
    expect(elevenLabsPhase("disconnected", after)).toBe("closed");
    expect(elevenLabsPhase("error", after)).toBe("closed");
    expect(elevenLabsPhase("disconnected", { grading: true, wasConnected: true })).toBe("closed");
    expect(elevenLabsPhase("connected", { grading: true, wasConnected: true })).toBe("closed");
  });

  it("never pairs a Connecting footer with a Grading header", () => {
    for (const s of ["connecting", "connected", "disconnecting", "disconnected", "error"]) {
      const copy = voiceStatusCopy(elevenLabsPhase(s, { grading: true, wasConnected: true }), false);
      expect(copy.footer.label).not.toMatch(/Connecting/);
      expect(copy.body).not.toMatch(/Connecting/);
    }
  });

  it("the ElevenLabs session uses it with the grading and connected facts", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toContain("const phase = elevenLabsPhase(status, { grading, wasConnected });");
    expect(trainer).toContain("attempts.connect(); setWasConnected(true); meterRef.current.open();");
    expect(trainer).not.toContain('connected ? "connected" : "connecting"');
  });
});

describe("callClockSeconds", () => {
  it("holds at 0 until connected, then counts from the connect moment", () => {
    expect(callClockSeconds(0, null)).toBe(0);
    expect(callClockSeconds(19, null)).toBe(0);
    expect(callClockSeconds(19, 19)).toBe(0);
    expect(callClockSeconds(20, 19)).toBe(1);
    expect(callClockSeconds(79, 19)).toBe(60);
    expect(callClockSeconds(3, 5)).toBe(0);
  });
});

describe("settleAbandonedCall (late mint after timeout, hang-up or unmount)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ends a late callId as failed_connect through the usage end call", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    settleAbandonedCall("call-late-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/usage/end");
    expect(JSON.parse(String(init.body))).toEqual({ callId: "call-late-1", reason: "failed_connect" });
  });

  it("does nothing without a callId, and never throws", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetchMock);
    settleAbandonedCall(undefined);
    settleAbandonedCall("");
    settleAbandonedCall(42);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => settleAbandonedCall("call-late-2")).not.toThrow();
    await Promise.resolve();
    vi.stubGlobal("fetch", () => { throw new Error("sync"); });
    expect(() => settleAbandonedCall("call-late-3")).not.toThrow();
  });

  it("the realtime call settles a mint that lands after close", () => {
    expect(src("src/components/call/RealtimeVoiceSession.tsx")).toMatch(/if \(this\.closed\) return settleAbandonedCall\(secret\.callId\);/);
  });

  it("an ElevenLabs token for a cancelled attempt is settled and starts no session", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    const settle = trainer.indexOf("if (cancelled()) return settleAbandonedCall(data.callId);");
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(trainer.indexOf("startSession({"));
    expect(settle).toBeLessThan(trainer.indexOf("meterRef.current = new CallMeter(data.callId"));
    expect(trainer).toMatch(/setTimeout\(\(\) => \{\s*if \(elevenLabsConnectTimeout\(attempts, /);
    expect(trainer).toContain("const cancelled = () => !attempts.isCurrent(attempt) || !mountedRef.current;");
  });

  it("an ElevenLabs hang-up before connect abandons the attempt as failed_connect and cancels, like the Realtime path", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    const body = trainer.slice(trainer.indexOf("const hangUp = useCallback("), trainer.indexOf("useEffect(() => registerEnd(hangUp)"));
    expect(body).toContain('if (elevenLabsHangUp(attempts, { endSession: () => { void endSession(); }, failAttempt }) === "cancelled") onCancelled();');
    // Connected comes from attempts (set in onConnect), never from the rendered status.
    expect(body).not.toMatch(/\bconnected\b(?!\()/);
    expect(trainer).toContain('const failAttempt = useCallback(() => { connectFailedRef.current = true; meterRef.current.end("failed_connect"); }, []);');
    // Never graded: a retry may have seeded rep turns.
    expect(body).not.toContain("onEnded()");
    // Both ways out of the call (the End button and the trainer's registered hang-up) use it.
    expect(trainer).toContain("useEffect(() => registerEnd(hangUp), [hangUp, registerEnd]);");
    expect(trainer).toContain("end: hangUp,");
    expect(trainer).not.toContain("end: () => endSession()");
    // The Realtime path it matches: not connected, so settled as failed_connect, closed without grading, cancelled.
    expect(src("src/components/call/RealtimeVoiceSession.tsx")).toMatch(/if \(this\.view\.phase !== "connected"\) \{\s*this\.meter\?\.end\("failed_connect"\);\s*this\.close\(false\);\s*return this\.h\.onCancelled\(\);\s*\}/);
  });

  it("the trainer returns a cancelled call to the briefing with no banner and grades nothing", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toContain('onCancelled: () => { setError(""); setConnectFailedError(""); mintedCallRef.current = null; setPhase("idle"); },');
    const cancel = trainer.slice(trainer.indexOf("onCancelled: () => {"), trainer.indexOf("onError: (m: string"));
    expect(cancel).not.toMatch(/finish|onVoiceEnded/);
  });
});

describe("ElevenLabs callbacks from an abandoned attempt (Codex review)", () => {
  const trainer = src("src/components/TrainerClient.tsx");
  const sdk = trainer.slice(trainer.indexOf("const conv = useConversation({"), trainer.indexOf("const { startSession, endSession"));

  it("VoiceAttempts: a session is live only while its attempt is current", () => {
    const a = new VoiceAttempts();
    expect(a.live()).toBe(false); // no session started yet
    const first = a.begin();
    expect(a.isCurrent(first)).toBe(true);
    expect(a.live()).toBe(false); // token still minting
    a.bind(first);
    expect(a.live()).toBe(true);
    a.abandon(); // timeout or hang-up while the SDK starts
    expect(a.isCurrent(first)).toBe(false);
    expect(a.live()).toBe(false);
    // A newer attempt does not revive the old session's callbacks until it binds its own.
    const second = a.begin();
    expect(a.live()).toBe(false);
    a.bind(second);
    expect(a.live()).toBe(true);
  });

  it("binds the attempt right before startSession", () => {
    expect(trainer).toMatch(/attempts\.bind\(attempt\);\s*startSession\(\{/);
  });

  it("a late connect for an abandoned attempt ends that session and never opens the meter", () => {
    expect(sdk).toMatch(/onConnect: \(\) => \{\s*\/\/[^\n]*\n\s*if \(!live\(\)\) \{ endRef\.current\(\); return; \}\s*attempts\.connect\(\); setWasConnected\(true\); meterRef\.current\.open\(\);/);
    expect(trainer).toContain("const live = () => attempts.live() && mountedRef.current;");
  });

  it("VoiceAttempts.connect: records the connect only for the current attempt, and a new attempt starts not connected", () => {
    const a = new VoiceAttempts();
    const first = a.begin();
    a.bind(first);
    expect(a.connected()).toBe(false);
    expect(a.connect()).toBe(true);
    expect(a.connected()).toBe(true);
    a.abandon();
    expect(a.connected()).toBe(false);
    expect(a.connect()).toBe(false); // a late connect for the abandoned attempt records nothing
    a.bind(a.begin());
    expect(a.connected()).toBe(false);
  });

  it("messages, errors and disconnects from an abandoned attempt are ignored, so nothing grades twice", () => {
    for (const cb of ["onMessage: ({ message, role }) => {", "onError: (m: unknown) => {", "onDisconnect: () => {"]) {
      const at = sdk.indexOf(cb);
      expect(at, cb).toBeGreaterThan(-1);
      expect(sdk.slice(at + cb.length).trimStart().startsWith("if (!live()) return;"), cb).toBe(true);
    }
  });

  it("CallMeter never starts heartbeats once ended, even if a late connect calls open()", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const meter = new CallMeter("call-abandoned", { onStop: () => {}, onGiveUp: () => {} });
      meter.end("failed_connect");
      meter.open();
      meter.audio();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]).toEqual([ "/api/usage/end", expect.anything() ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("hang-up and timeout right after onConnect, before the connected render (Codex re-review)", () => {
  const trainer = src("src/components/TrainerClient.tsx");
  const deps = () => ({ endSession: vi.fn(), failAttempt: vi.fn() });
  /** onConnect has run (synchronously) for the current attempt; React has not rendered status "connected" yet. */
  const justConnected = () => { const a = new VoiceAttempts(); a.bind(a.begin()); a.connect(); return a; };
  const notConnected = () => { const a = new VoiceAttempts(); a.bind(a.begin()); return a; };

  it("a hang-up in that gap ends a connected call (graded on disconnect), not a failed connect", () => {
    const a = justConnected();
    const d = deps();
    expect(elevenLabsHangUp(a, d)).toBe("ended");
    expect(d.endSession).toHaveBeenCalledOnce();
    expect(d.failAttempt).not.toHaveBeenCalled();
    // The attempt stays current, so its onDisconnect still runs and grades the transcript.
    expect(a.live()).toBe(true);
  });

  it("a hang-up before onConnect still cancels: abandoned, failed_connect, session ended", () => {
    const a = notConnected();
    const d = deps();
    expect(elevenLabsHangUp(a, d)).toBe("cancelled");
    expect(d.failAttempt).toHaveBeenCalledOnce();
    expect(d.endSession).toHaveBeenCalledOnce();
    expect(a.live()).toBe(false);
  });

  it("a timeout that fires in that gap does nothing: the call is connected", () => {
    const a = justConnected();
    const d = deps();
    expect(elevenLabsConnectTimeout(a, d)).toBe(false);
    expect(d.endSession).not.toHaveBeenCalled();
    expect(d.failAttempt).not.toHaveBeenCalled();
    expect(a.live()).toBe(true);
  });

  it("a timeout before onConnect stops the attempt and asks for the timeout error", () => {
    const a = notConnected();
    const d = deps();
    expect(elevenLabsConnectTimeout(a, d)).toBe(true);
    expect(d.failAttempt).toHaveBeenCalledOnce();
    expect(d.endSession).toHaveBeenCalledOnce();
    expect(a.live()).toBe(false);
  });

  it("the session wires both to attempts, and reports the timeout error only when it stopped the attempt", () => {
    expect(trainer).toContain("if (elevenLabsConnectTimeout(attempts, { endSession: () => endRef.current(), failAttempt })) onErrorRef.current(CONNECT_TIMEOUT_MESSAGE, { connectFailed: true });");
    expect(trainer).not.toContain("connectedRef");
  });
});

describe("connect timeout", () => {
  it("is a fixed 20 second limit", () => {
    expect(CONNECT_TIMEOUT_MS).toBe(20_000);
    expect(CONNECT_TIMEOUT_MESSAGE).toMatch(/20 seconds/);
  });

  it("ends a stuck realtime attempt through the existing failed_connect path", () => {
    const realtime = src("src/components/call/RealtimeVoiceSession.tsx");
    expect(realtime).toMatch(/this\.fail\(CONNECT_TIMEOUT_MESSAGE, "failed_connect"\)/);
    expect(realtime).toContain("CONNECT_TIMEOUT_MS");
    expect(realtime).toMatch(/clearTimeout\(this\.connectTimer\);\s*this\.set\(\{ phase: "connected" \}\)/);
  });

  it("ends a stuck ElevenLabs attempt and settles the meter as failed_connect", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toMatch(/if \(elevenLabsConnectTimeout\(attempts, \{ endSession: \(\) => endRef\.current\(\), failAttempt \}\)\) onErrorRef\.current\(CONNECT_TIMEOUT_MESSAGE, \{ connectFailed: true \}\)/);
    expect(trainer).toContain('meterRef.current.end("failed_connect");');
  });
});

describe("a failed connect on a retry with prior turns (SAL-1039 round 3)", () => {
  it("leavesCallOnError: a call that never connected always goes back to the briefing", () => {
    expect(leavesCallOnError({ connectFailed: true }, true)).toBe(true);
    expect(leavesCallOnError({ connectFailed: true }, false)).toBe(true);
    // After connect, the old rule stands: stay to grade what the rep said, else go back.
    expect(leavesCallOnError({ connectFailed: false }, true)).toBe(false);
    expect(leavesCallOnError(undefined, true)).toBe(false);
    expect(leavesCallOnError(undefined, false)).toBe(true);
  });

  it("the trainer decides with leavesCallOnError, so seeded rep turns cannot keep it on a dead deck", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toMatch(/onError: \(m: string, info\?: VoiceErrorInfo\) => \{ setError\(m\); setConnectFailedError\([^;]*\); if \(leavesCallOnError\(info, turnsRef\.current\.some\(/);
  });

  it("the Realtime call flags any failure before connect, timeout included", () => {
    const realtime = src("src/components/call/RealtimeVoiceSession.tsx");
    expect(realtime).toContain('this.h.onError(msg, { connectFailed: this.view.phase === "mic" || this.view.phase === "connecting" });');
    expect(realtime).toContain("onError: (m, i) => cb.current.onError(m, i),");
  });

  it("ElevenLabs flags a token failure and the timeout, and the disconnect after a timeout does not grade", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toContain('onError(e instanceof Error ? e.message : "Failed to start the call.", { connectFailed: true });');
    expect(trainer).toContain("if (!connectFailedRef.current) onEnded();");
    expect(trainer).toMatch(/userEndedRef\.current = false;\s*connectFailedRef\.current = false;/);
  });

  it("any ElevenLabs SDK error before connect is a connect failure, and its disconnect does not grade", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    const sdk = trainer.slice(trainer.indexOf("const conv = useConversation({"), trainer.indexOf("const { startSession, endSession"));
    expect(sdk).toMatch(/attempts\.connect\(\); setWasConnected\(true\); meterRef\.current\.open\(\);\s*\},/);
    expect(sdk).toMatch(/const beforeConnect = !attempts\.connected\(\);\s*if \(beforeConnect\) connectFailedRef\.current = true;\s*onError\([^;]*beforeConnect \? \{ connectFailed: true \} : undefined\);/);
    expect(sdk).toContain("if (!connectFailedRef.current) onEnded();");
    // Each attempt starts not failed, and not connected until its own session binds and connects (VoiceAttempts).
    expect(trainer).toMatch(/userEndedRef\.current = false;\s*connectFailedRef\.current = false;/);
    expect(trainer).toMatch(/attempts\.bind\(attempt\);\s*startSession\(\{/);
  });

  it("back on the briefing, a connect failure offers Retry voice and Switch to text even with a retry seed", () => {
    const briefing = src("src/components/call/Briefing.tsx");
    // The actions depend on the connect-failure flag and Voice mode, never on retryFrom, the transcript or the message text.
    expect(briefing).toContain('{error && connectFailed && mode === "voice" && (!isCapMessage(error) || !textSwitchShown) && (');
    expect(briefing).not.toContain("CONNECT_TIMEOUT_MESSAGE");
  });

  it("a cap refusal before connect gets only Switch to text, next to the existing Upgrade link or admin note", () => {
    const briefing = src("src/components/call/Briefing.tsx");
    const block = briefing.slice(briefing.indexOf('{error && connectFailed && mode === "voice"'), briefing.indexOf("Minutes near Start"));
    // Retry voice is hidden only for a cap refusal.
    expect(block).toMatch(/\{!isCapMessage\(error\) && \(\s*<button[^>]*onClick=\{onStart\}[^>]*>\s*<RotateCcw[^>]*\/>Retry voice\s*<\/button>\s*\)\}/);
    // Switch to text does not depend on the cap refusal, only on whether another switch button is already showing.
    expect(block).toMatch(/\{!textSwitchShown && \(\s*<button type="button" className="btn-ghost btn-sm" onClick=\{switchToText\}>/);
    // The Upgrade link and admin note stay in CallError, which still renders for the cap refusal.
    expect(briefing).toContain("{error && !(outOfMinutes && isCapMessage(error)) && <CallError message={error} canUpgrade={canUpgrade} />}");
  });

  it("the error offers Retry voice and Switch to text, through the same switch handler as main's buttons", () => {
    const briefing = src("src/components/call/Briefing.tsx");
    expect(briefing).toMatch(/onClick=\{onStart\}[^>]*>\s*<RotateCcw[^>]*\/>Retry voice/);
    expect(briefing).toMatch(/onClick=\{switchToText\}>\s*<Keyboard[^>]*\/>Switch to text/);
    expect(briefing).not.toContain('onModeChange("text")}>');
  });

  it("never shows two Switch to text buttons: ours hides exactly when VoiceUnavailable or the out-of-minutes button shows", () => {
    const briefing = src("src/components/call/Briefing.tsx");
    expect(briefing).toContain("const textSwitchShown = voiceLookupFailed || outOfMinutes;");
    expect(briefing).toContain("{voiceLookupFailed && <VoiceUnavailable onUseText={switchToText} />}");
    expect(briefing).toMatch(/\{outOfMinutes && !voiceLookupFailed && <button[^>]*onClick=\{switchToText\}>Switch to text practice<\/button>\}/);
  });

  it("the merge keeps main's chooseMode and onUseText next to connectFailed, with no conflict markers", () => {
    const trainer = src("src/components/TrainerClient.tsx");
    expect(trainer).toMatch(/<Briefing [^>]*onModeChange=\{chooseMode\} onUseText=\{\(\) => setMode\("text"\)\}[^>]*connectFailed=\{!!error && error === connectFailedError\}/);
    for (const p of ["src/components/TrainerClient.tsx", "src/components/call/Briefing.tsx"]) expect(src(p)).not.toMatch(/^(<{7}|={7}|>{7})( |$)/m);
  });
});

describe("connect-failure flag travels with the error (round 5)", () => {
  const trainer = src("src/components/TrainerClient.tsx");

  it("the trainer stores which error was a connect failure, from the session's metadata", () => {
    expect(trainer).toContain('setError(m); setConnectFailedError(info?.connectFailed ? m : "");');
  });

  it("the flag is tied to the current error, so clearing or replacing the error clears it", () => {
    expect(trainer).toContain("connectFailed={!!error && error === connectFailedError}");
  });

  it("every pre-connect failure carries the flag: timeout, ElevenLabs SDK and token errors, Realtime mint and handshake", () => {
    expect(trainer).toContain("onErrorRef.current(CONNECT_TIMEOUT_MESSAGE, { connectFailed: true });");
    expect(trainer).toContain("beforeConnect ? { connectFailed: true } : undefined");
    expect(trainer).toContain('"Failed to start the call.", { connectFailed: true }');
    // Realtime: fail() flags by phase, so mint, SDP and handshake failures before connect all carry it.
    expect(src("src/components/call/RealtimeVoiceSession.tsx")).toContain('connectFailed: this.view.phase === "mic" || this.view.phase === "connecting"');
  });
});

describe("Realtime connect sequence stops once closed (round 5)", () => {
  const realtime = src("src/components/call/RealtimeVoiceSession.tsx");

  it("checks closed after createOffer and setLocalDescription, before any SDP request", () => {
    expect(realtime).toMatch(/await pc\.createOffer\(\);\s*if \(this\.closed\) return;\s*await pc\.setLocalDescription\(offer\);\s*if \(this\.closed\) return;/);
    const guard = realtime.indexOf("await pc.setLocalDescription(offer);\n      if (this.closed) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(realtime.indexOf('fetch("/api/live/sdp"'));
    expect(guard).toBeLessThan(realtime.indexOf('fetch("/api/realtime/sdp"'));
    expect(realtime).toMatch(/await iceGathered\(pc\);\s*if \(this\.closed\) return;\s*const res = await fetch\("\/api\/live\/sdp"/);
  });

  it("checks closed after each SDP answer, before setRemoteDescription", () => {
    const remotes = [...realtime.matchAll(/await pc\.setRemoteDescription/g)].map((m) => m.index!);
    expect(remotes).toHaveLength(2);
    for (const at of remotes) {
      const before = realtime.slice(realtime.lastIndexOf("const data = await res.json()", at), at);
      expect(before).toContain("if (this.closed) return this.dropLateAnswer();");
    }
  });

  it("both SDP requests can be aborted by close(); the mint is not, so a late callId is still settled", () => {
    expect(realtime.match(/signal: this\.sdpAbort\.signal/g)).toHaveLength(2);
    expect(realtime).toMatch(/this\.closed = true;\s*\/\/[^\n]*\n\s*this\.sdpAbort\.abort\(\);/);
    const mint = realtime.slice(realtime.indexOf('fetch("/api/realtime/session"'), realtime.indexOf("secret = await res.json()"));
    expect(mint).not.toContain("signal");
  });
});

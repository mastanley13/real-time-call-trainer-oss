"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Scenario } from "@/lib/scenarios";
import type { MintedCall, StoredTurn } from "@/lib/sessionStore";
import type { AgentState } from "@/components/CallOrb";
import type { MeterEndReason } from "@/lib/callMeter";
import { DROPPED_BEFORE_CONNECT_MESSAGE, VoiceAttempt } from "@/lib/voiceAttempt";
import { LiveTranscript, applyLiveEvent, type LiveServerEvent } from "@/lib/live";
import { expireSession, storedSessionKey } from "@/lib/sessionExpiry";
import { TurnAssembler, applyRealtimeEvent, averageLevel, micErrorMessage, openingInstructions, realtimeAuthRedirect, type AssembledTurn, type RealtimeServerEvent } from "@/lib/realtime";

/** Same render-prop contract as the ElevenLabs VoiceSession in TrainerClient. */
export interface VoiceRender {
  orbState: AgentState;
  status: { label: string; tone: "ok" | "signal" | "caution" };
  muted: boolean;
  toggleMute: () => void;
  end: () => void;
  getInputVolume: () => number;
  getOutputVolume: () => number;
}

type CallPhase = "mic" | "connecting" | "connected" | "ending" | "closed";
interface CallView { phase: CallPhase; speaking: boolean; muted: boolean }
interface Handlers {
  onTurn: (t: AssembledTurn) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  /** The attempt ended before it connected (src/lib/voiceAttempt.ts): back to the briefing with the message, no grading. */
  onCancelled: (msg: string) => void;
  onView: (v: CallView) => void;
  /**
   * Which call the server minted: its sessionId, the receipt bound to it, and the metering callId when metered.
   * The call is saved with all three, so the server logs the minted model on this call's own row. Opaque here.
   */
  onMinted: (c: MintedCall) => void;
  /** The voice tier this call was minted on, and whether the next call drops to Standard. Labels only, no model id. */
  onVoiceInfo: (info: VoiceInfo) => void;
}

/**
 * `trial`: this is the organization's one Premium trial call (up to 5 minutes). `maxSeconds`: the server's deadline
 * for THIS call, when it said. Labels and numbers only, no model id.
 */
export interface VoiceInfo { tier: "premium" | "standard"; nextCallStandard: boolean; trial: boolean; maxSeconds?: number }

/** Reads the tier label from a mint answer (realtime session or ElevenLabs token). Null when the server did not say. */
export function voiceInfoFrom(data: { voiceTier?: unknown; nextCallStandard?: unknown; voiceTrial?: unknown; maxSeconds?: unknown } | null | undefined): VoiceInfo | null {
  if (data?.voiceTier !== "premium" && data?.voiceTier !== "standard") return null;
  const max = typeof data.maxSeconds === "number" && Number.isFinite(data.maxSeconds) && data.maxSeconds > 0 ? Math.floor(data.maxSeconds) : undefined;
  return { tier: data.voiceTier, nextCallStandard: data.nextCallStandard === true, trial: data.voiceTier === "premium" && data.voiceTrial === true, ...(max ? { maxSeconds: max } : {}) };
}

const EXPIRED = "The voice session expired before it connected. Start the call again.";
/** Grace period on hang-up so the trainee's last words still get transcribed. */
const END_GRACE_MS = 1500;

/**
 * One OpenAI Realtime call over WebRTC (https://developers.openai.com/api/docs/guides/realtime-webrtc).
 * Kept outside React so StrictMode remounts and re-renders never touch the live connection;
 * each mount owns exactly one call and closes it exactly once.
 *
 * Each call is one VoiceAttempt (src/lib/voiceAttempt.ts): every exit before the call connects goes through the
 * attempt's one cancel(), whose teardown() here aborts a pending SDP request and closes the peer connection and mic. See
 * the table at the top of voiceAttempt.ts for each path. After connect, the connected-call paths below are unchanged.
 */
export class RealtimeCall {
  private view: CallView = { phase: "mic", speaking: false, muted: false };
  private closed = false;
  private ending = false;
  /** Rep turns emitted so far. The persona's opening line alone is nothing to grade. */
  private emittedUser = 0;
  private asm = new TurnAssembler();
  /**
   * Set when the server answered with a GPT-Live ticket (OPENAI_VOICE_API=live) instead of a Realtime client secret.
   * GPT-Live sends transcript deltas with timeline offsets instead of items, so it has its own assembler.
   */
  private live?: LiveTranscript;
  /** Wall-clock time of the last persona transcript delta (Live has no output-audio start/stop events). */
  private lastPersonaDelta = 0;
  private ctx?: AudioContext;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private remote?: MediaStream;
  private audio?: HTMLAudioElement;
  private inAn?: AnalyserNode;
  private outAn?: AnalyserNode;
  private bins = new Uint8Array(128);
  private flushTimer?: ReturnType<typeof setInterval>;
  private endTimer?: ReturnType<typeof setTimeout>;
  private audioTimer?: ReturnType<typeof setInterval>;
  /**
   * This call's attempt: its meter reports connect, heartbeats and the end to the server (nothing without a callId), and
   * its page-hide observer runs from here, before the mic prompt, until the call connects.
   */
  private attempt: VoiceAttempt;
  /** Aborts a pending SDP request when the call closes, so a closed call never finishes its connection. */
  private abort = new AbortController();

  constructor(private scenario: Scenario, private h: Handlers, private voiceTier?: "premium" | "standard") {
    this.attempt = new VoiceAttempt({ teardown: () => this.teardown(), onCancelled: (m) => this.h.onCancelled(m) });
  }

  private set(p: Partial<CallView>) {
    this.view = { ...this.view, ...p };
    if (!this.closed || p.phase === "closed") this.h.onView(this.view);
  }

  async start() {
    // Created before any await so it inherits the Start call click's user activation (Safari needs that).
    try { this.ctx = new AudioContext(); } catch { /* volume meters stay flat; audio still plays */ }

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      return this.fail(micErrorMessage(e)); // row 4
    }
    // Hung up, unmounted or page hidden during the mic prompt (row 5): stop the stream that arrived, and never mint.
    if (this.closed) { mic.getTracks().forEach((t) => t.stop()); return; }
    this.mic = mic;
    mic.getAudioTracks().forEach((t) => (t.enabled = !this.view.muted));
    this.set({ phase: "connecting" });

    let secret: { clientSecret?: string; liveTicket?: string; voiceApi?: unknown; expiresAt?: number; message?: string; callId?: string; receipt?: unknown; sessionId?: unknown; voiceTier?: unknown; nextCallStandard?: unknown; voiceTrial?: unknown; maxSeconds?: unknown; error?: unknown };
    try {
      // The rep's Standard or Premium pick is a request; the server rechecks entitlement and decides.
      const session = storedSessionKey();
      const res = await fetch("/api/realtime/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: this.scenario, ...(this.voiceTier ? { voiceTier: this.voiceTier } : {}) }) });
      secret = await res.json().catch(() => ({}));
      // The meter exists as soon as the server answers, so every exit from here on reports the end. An attempt canceled
      // while the mint was pending reports this callId now and goes no further (row 7). Without a callId (unmetered) the
      // meter sends nothing, but it still says when the call connected.
      const stillLive = this.attempt.minted(typeof secret.callId === "string" ? secret.callId : undefined, {
        // The server has already stopped and billed the call; this ends the client side.
        onStop: (m) => this.fail(m, "user_hangup"),
        onGiveUp: () => this.dropped("The voice connection dropped. Check your network. Your transcript so far is kept."),
      });
      if (!stillLive || this.closed) return;
      const redirect = realtimeAuthRedirect(res.status, secret.error);
      if (redirect) return this.signInAgain(redirect, session);
      if (!res.ok || !(secret.clientSecret || secret.liveTicket)) return this.fail(secret.message || "Could not start the voice call. Try again, or switch to Text.");
    } catch {
      return this.fail("Could not reach the server to start the voice call. Check your connection, then try again.");
    }
    if (this.closed) return;
    if (secret.voiceApi === "live" && typeof secret.liveTicket === "string") this.live = new LiveTranscript();
    if (typeof secret.sessionId === "string" && (secret.clientSecret || this.live)) {
      this.h.onMinted({
        sessionId: secret.sessionId,
        ...(typeof secret.receipt === "string" ? { receipt: secret.receipt } : {}),
        ...(typeof secret.callId === "string" ? { callId: secret.callId } : {}),
      });
    }
    const info = voiceInfoFrom(secret);
    if (info) this.h.onVoiceInfo(info);
    if (secret.expiresAt && secret.expiresAt * 1000 <= Date.now()) return this.fail(EXPIRED, "failed_connect");

    try {
      void this.ctx?.resume().catch(() => {});
      this.inAn = this.analyse(mic);
      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => {
        const [stream] = e.streams;
        if (!stream || this.closed) return;
        this.remote = stream;
        audio.srcObject = stream; // also required for Chrome to feed a remote WebRTC stream into WebAudio
        this.outAn = this.analyse(stream);
        void audio.play().catch(() => {});
        this.watchFirstAudio(pc);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") this.dropped("The voice connection dropped. Check your network. Your transcript so far is kept.");
        // A disconnect gets 10 seconds to recover; the same call and the same rounding continue if it does.
        else if (pc.connectionState === "disconnected") this.attempt.meter.trouble();
        else if (pc.connectionState === "connected") this.attempt.meter.recovered();
      };
      mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => this.opened();
      dc.onmessage = (e) => this.message(e.data);
      dc.onclose = () => { if (!this.closed && !this.ending) this.dropped("The voice session closed unexpectedly. Your transcript so far is kept."); };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.live) {
        // GPT-Live: the server starts the session with the full offer (src/app/api/live/sdp/route.ts).
        await iceGathered(pc);
        if (this.closed) return;
        const liveSession = storedSessionKey();
        const res = await fetch("/api/live/sdp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ liveTicket: secret.liveTicket, sessionId: secret.sessionId, scenario: this.scenario, sdp: pc.localDescription?.sdp ?? offer.sdp }), signal: this.abort.signal });
        const data = await res.json().catch(() => ({}));
        if (this.closed) return;
        const redirect = data.error === "realtime_secret_expired" ? null : realtimeAuthRedirect(res.status, data.error);
        if (redirect) return this.signInAgain(redirect, liveSession);
        if (!res.ok || typeof data.sdp !== "string") return this.fail(data.error === "realtime_secret_expired" ? EXPIRED : data.message || "OpenAI could not connect the voice call. Try again, or switch to Text.", "failed_connect");
        await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        return;
      }
      // Same-origin relay of the documented SDP exchange; see src/app/api/realtime/sdp/route.ts.
      const sdpSession = storedSessionKey();
      const res = await fetch("/api/realtime/sdp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientSecret: secret.clientSecret, sdp: offer.sdp }), signal: this.abort.signal });
      const data = await res.json().catch(() => ({}));
      if (this.closed) return;
      const redirect = realtimeAuthRedirect(res.status, data.error);
      if (redirect) return this.signInAgain(redirect, sdpSession);
      if (!res.ok || typeof data.sdp !== "string") return this.fail(data.error === "realtime_secret_expired" ? EXPIRED : data.message || "OpenAI could not connect the voice call. Try again, or switch to Text.", "failed_connect");
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    } catch {
      this.fail("Could not connect the voice call. Check your network and try again, or switch to Text.", "failed_connect");
    }
  }

  /** The first inbound audio packet is the last of the three conditions for "connected" (see CallMeter). */
  private watchFirstAudio(pc: RTCPeerConnection) {
    if (this.audioTimer) return;
    this.audioTimer = setInterval(async () => {
      if (this.closed) return clearInterval(this.audioTimer);
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && r.kind === "audio" && r.packetsReceived > 0) {
            clearInterval(this.audioTimer);
            this.attempt.meter.audio();
          }
        });
      } catch { /* stats unavailable; try again on the next tick */ }
    }, 500);
  }

  private analyse(stream: MediaStream): AnalyserNode | undefined {
    if (!this.ctx) return undefined;
    try {
      const an = this.ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.6;
      this.ctx.createMediaStreamSource(stream).connect(an); // analysis only; playback goes through the <audio> element
      return an;
    } catch {
      return undefined;
    }
  }

  private level(an?: AnalyserNode): number {
    if (!an || this.closed) return 0;
    an.getByteFrequencyData(this.bins);
    return averageLevel(this.bins);
  }

  inputLevel = () => (this.view.muted ? 0 : this.level(this.inAn));
  outputLevel = () => this.level(this.outAn);

  private send(ev: object) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(ev));
  }

  private opened() {
    if (this.closed) return;
    this.set({ phase: "connected" });
    this.attempt.meter.open();
    this.flushTimer = setInterval(() => this.release(), 1000);
    // GPT-Live: the opening line was given at startup (session.input) and the persona decides when to speak.
    if (this.live) return;
    // response.create with per-response instructions is the documented way to steer one reply;
    // it lands in the default conversation, so the persona remembers saying it.
    const line = this.scenario.aiPersona.openingLine.trim();
    if (line) this.send({ type: "response.create", response: { instructions: openingInstructions(this.scenario.aiPersona.name, line) } });
  }

  private message(raw: unknown) {
    if (this.closed || typeof raw !== "string") return;
    if (this.live) return this.liveMessage(raw, this.live);
    let ev: RealtimeServerEvent;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "output_audio_buffer.started": this.set({ speaking: true }); break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": this.set({ speaking: false }); break;
      case "error":
        // Most realtime errors are per-event and non-fatal (e.g. canceling an idle response). Expiry ends the call.
        if (ev.error?.code === "session_expired") {
          if (this.attempt.cancel("error", EXPIRED)) return; // row 12: before connect
          return this.fail("The voice session reached OpenAI's time limit. Your transcript so far is kept.", "provider_error");
        }
        console.warn("[realtime]", ev.error?.code ?? ev.error?.type ?? "error");
        return;
    }
    if (applyRealtimeEvent(this.asm, ev)) this.release();
  }

  /** GPT-Live events (https://developers.openai.com/api/docs/guides/live-conversations). */
  private liveMessage(raw: string, live: LiveTranscript) {
    let ev: LiveServerEvent;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "session.output_transcript.delta":
        this.lastPersonaDelta = Date.now();
        if (!this.view.speaking) this.set({ speaking: true });
        break;
      case "session.closed":
        // Connection loss, safety termination or a server limit. A hang-up we started is already closing.
        if (!this.ending) return this.dropped("The voice session ended. Your transcript so far is kept.", ev.reason === "close_requested" ? "user_hangup" : "provider_error");
        return;
      case "error":
        // Errors on a running Live session are per command or a moderation cut-off of one reply; the session continues.
        console.warn("[live]", ev.error?.code ?? ev.error?.type ?? "error");
        return;
    }
    if (applyLiveEvent(live, ev)) this.release();
  }

  private release(force = false) {
    // Live has no speaking-stopped event: the persona counts as speaking until its transcript pauses briefly.
    if (this.live && this.view.speaking && Date.now() - this.lastPersonaDelta > 900) this.set({ speaking: false });
    for (const t of (this.live ?? this.asm).flush(Date.now(), force)) {
      if (t.role === "user" && t.text.trim()) this.emittedUser += 1;
      this.h.onTurn(t);
    }
  }

  toggleMute = () => {
    const muted = !this.view.muted;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
  };

  /** Hang up: stop the mic and the persona now, wait briefly for the last transcript, then close and report. */
  end = () => {
    if (this.closed || this.ending) return;
    // Before connect (row 1): the attempt's one cancel, at once, no grace; back to the briefing.
    if (this.attempt.cancel("hang_up")) return;
    this.ending = true;
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = false));
    if (this.audio) this.audio.muted = true;
    this.set({ phase: "ending", speaking: false });
    const until = Date.now() + END_GRACE_MS;
    const wait = () => {
      if (this.closed) return;
      if ((this.live ?? this.asm).pending === 0 || Date.now() >= until) this.close(true);
      else this.endTimer = setTimeout(wait, 100);
    };
    wait();
  };

  /** Before connect: the attempt's one cancel with `msg` (rows 4, 6, 10, 11, 12). After: the connected-call failure. */
  private fail(msg: string, reason: MeterEndReason = "failed_connect") {
    if (this.closed) return;
    if (this.attempt.cancel("error", msg)) return;
    this.attempt.meter.end(reason);
    this.release(true);
    const repSpoke = this.emittedUser > 0;
    this.h.onError(msg);
    // Once the rep has spoken the call still gets graded; before that, the trainer goes back to the briefing and keeps this error.
    this.close(repSpoke);
  }

  /** The transport closed. Before connect: row 13, with its own message. After: the connected-call failure, as before. */
  private dropped(connectedMessage: string, reason: MeterEndReason = "network_drop") {
    if (this.closed) return;
    if (this.attempt.cancel("error", DROPPED_BEFORE_CONNECT_MESSAGE)) return;
    this.fail(connectedMessage, reason);
  }

  /**
   * Row 9. `session` is the client session key (storedSessionKey) read when the rejected request started. Nothing has
   * connected: the attempt's cancel reports a minted call as failed_connect and stops the mic and peer before leaving,
   * and nothing is graded.
   */
  private signInAgain(path: "/login" | "/access", session: string | null) {
    this.attempt.cancel("sign_in", () => {
      if (path === "/access") { window.location.assign(path); return null; }
      // The shared guard clears the cached session (it can look fresh while the server rejects the cookie) and
      // makes the one redirect to /login?next=&reason=expired. It leaves a newer sign-in alone; then this
      // request was stale, so let the rep start again.
      return expireSession(session) === "stale" ? "Could not start the voice call. Try again, or switch to Text." : null;
    });
  }

  /**
   * Hang-up grace ran out (notify=true) or unmount (notify=false, which must not trigger grading). Before connect this
   * is the attempt's one cancel (rows 1 and 3); after, the connected call ends and is reported as before.
   */
  close(notify: boolean) {
    if (this.closed) return;
    if (this.attempt.cancel(notify ? "hang_up" : "unmount")) return;
    // A failure already reported its own reason (the meter ignores a second end).
    this.attempt.meter.end("user_hangup");
    this.attempt.finish();
    if (notify) this.release(true);
    this.teardown();
    if (notify) this.h.onEnded();
  }

  /** Releases everything exactly once: the attempt's teardown, and the end of a connected call. */
  private teardown() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    clearInterval(this.flushTimer);
    clearInterval(this.audioTimer);
    clearTimeout(this.endTimer);
    // GPT-Live: ask for a graceful close so usage is finalized; closing the connection below also ends billing.
    if (this.live) { try { this.send({ type: "session.close" }); } catch { /* channel already gone */ } }
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.mic?.getTracks().forEach((t) => t.stop());
    this.remote?.getTracks().forEach((t) => t.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
    this.set({ phase: "closed", speaking: false });
  }
}

/** Resolves once ICE gathering finishes (GPT-Live gets the whole offer in one request), or after 3 s with what it has. */
function iceGathered(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Voice session on the OpenAI Realtime API, or GPT-Live when the server sets OPENAI_VOICE_API=live. Drop-in for the ElevenLabs VoiceSession. */
export default function RealtimeVoiceSession({ scenario, active, grading, onTurn, onEnded, onError, onCancelled, onMinted, onVoiceInfo, registerEnd, render, voiceTier }: {
  scenario: Scenario;
  /** The setup's Standard or Premium pick for this call, sent as a request. Read when the call starts. */
  voiceTier?: "premium" | "standard";
  active: boolean;
  grading: boolean;
  onTurn: (t: StoredTurn) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  /** The attempt ended before it connected: back to the briefing with the message, nothing graded. */
  onCancelled: (msg: string) => void;
  onMinted?: (c: MintedCall) => void;
  onVoiceInfo?: (info: VoiceInfo) => void;
  registerEnd: (fn: () => void) => void;
  render: (v: VoiceRender) => React.ReactNode;
}) {
  const [view, setView] = useState<CallView>({ phase: "mic", speaking: false, muted: false });
  const callRef = useRef<RealtimeCall | null>(null);
  // Latest callbacks without restarting the call when the parent re-renders.
  const cb = useRef({ onTurn, onEnded, onError, onCancelled, onMinted, onVoiceInfo });
  useEffect(() => { cb.current = { onTurn, onEnded, onError, onCancelled, onMinted, onVoiceInfo }; });
  // The pick at the moment the call starts; changing it later never restarts or switches a running call.
  const tierRef = useRef(voiceTier);
  useEffect(() => { tierRef.current = voiceTier; });

  useEffect(() => {
    if (!active) return;
    const call = new RealtimeCall(scenario, {
      onTurn: (t) => cb.current.onTurn(t),
      onEnded: () => cb.current.onEnded(),
      onError: (m) => cb.current.onError(m),
      onCancelled: (m) => cb.current.onCancelled(m),
      onView: (v) => { if (callRef.current === call) setView(v); },
      onMinted: (c) => cb.current.onMinted?.(c),
      onVoiceInfo: (i) => cb.current.onVoiceInfo?.(i),
    }, tierRef.current);
    callRef.current = call;
    setView({ phase: "mic", speaking: false, muted: false });
    void call.start();
    return () => {
      call.close(false);
      if (callRef.current === call) callRef.current = null;
    };
  }, [active, scenario]);

  const end = useCallback(() => callRef.current?.end(), []);
  const toggleMute = useCallback(() => callRef.current?.toggleMute(), []);
  const getInputVolume = useCallback(() => callRef.current?.inputLevel() ?? 0, []);
  const getOutputVolume = useCallback(() => callRef.current?.outputLevel() ?? 0, []);

  useEffect(() => registerEnd(end), [end, registerEnd]);

  const connected = view.phase === "connected";
  const name = scenario.aiPersona.name.split(" ")[0];
  const orbState: AgentState = grading || !connected ? "thinking" : view.speaking ? "talking" : "listening";
  const status = view.phase === "mic" ? { label: "Allow the mic to connect", tone: "caution" as const }
    : view.phase === "connecting" ? { label: "Connecting…", tone: "caution" as const }
    : view.phase === "ending" ? { label: "Wrapping up…", tone: "signal" as const }
    : view.phase === "closed" ? { label: "Call ended", tone: "caution" as const }
    : view.muted ? { label: "Muted", tone: "caution" as const }
    : view.speaking ? { label: `${name} is speaking`, tone: "signal" as const }
    : { label: "Your turn", tone: "ok" as const };

  return <>{render({ orbState, status, muted: view.muted, toggleMute, end, getInputVolume, getOutputVolume })}</>;
}

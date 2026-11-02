"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Scenario } from "@/lib/scenarios";
import type { StoredTurn } from "@/lib/sessionStore";
import type { AgentState } from "@/components/CallOrb";
import { CallMeter, type MeterEndReason } from "@/lib/callMeter";
import { TurnAssembler, applyRealtimeEvent, averageLevel, micErrorMessage, openingInstructions, type AssembledTurn, type RealtimeServerEvent } from "@/lib/realtime";

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
  onView: (v: CallView) => void;
}

const EXPIRED = "The voice session expired before it connected. Start the call again.";
/** Grace period on hang-up so the trainee's last words still get transcribed. */
const END_GRACE_MS = 1500;

/**
 * One OpenAI Realtime call over WebRTC (https://developers.openai.com/api/docs/guides/realtime-webrtc).
 * Kept outside React so StrictMode remounts and re-renders never touch the live connection;
 * each mount owns exactly one call and closes it exactly once.
 */
class RealtimeCall {
  private view: CallView = { phase: "mic", speaking: false, muted: false };
  private closed = false;
  private ending = false;
  /** Rep turns emitted so far. The persona's opening line alone is nothing to grade. */
  private emittedUser = 0;
  private asm = new TurnAssembler();
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
  /** Reports connect, heartbeats and the end to the server, which meters the call. A no-op without a callId. */
  private meter?: CallMeter;

  constructor(private scenario: Scenario, private h: Handlers) {}

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
      return this.fail(micErrorMessage(e));
    }
    if (this.closed) { mic.getTracks().forEach((t) => t.stop()); return; }
    this.mic = mic;
    mic.getAudioTracks().forEach((t) => (t.enabled = !this.view.muted));
    this.set({ phase: "connecting" });

    let secret: { clientSecret?: string; expiresAt?: number; message?: string; callId?: string };
    try {
      const res = await fetch("/api/realtime/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario: this.scenario }) });
      secret = await res.json().catch(() => ({}));
      if (!res.ok || !secret.clientSecret) return this.fail(secret.message || "Could not start the voice call. Try again, or switch to Text.");
    } catch {
      return this.fail("Could not reach the server to start the voice call. Check your connection, then try again.");
    }
    if (this.closed) return;
    this.meter = new CallMeter(secret.callId, {
      // The server has already stopped and billed the call; this ends the client side.
      onStop: (m) => this.fail(m, "user_hangup"),
      onGiveUp: () => this.fail("The voice connection dropped. Check your network. Your transcript so far is kept.", "network_drop"),
    });
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
        if (pc.connectionState === "failed") this.fail("The voice connection dropped. Check your network. Your transcript so far is kept.", "network_drop");
        // A disconnect gets 10 seconds to recover; the same call and the same rounding continue if it does.
        else if (pc.connectionState === "disconnected") this.meter?.trouble();
        else if (pc.connectionState === "connected") this.meter?.recovered();
      };
      mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => this.opened();
      dc.onmessage = (e) => this.message(e.data);
      dc.onclose = () => { if (!this.closed && !this.ending) this.fail("The voice session closed unexpectedly. Your transcript so far is kept.", "network_drop"); };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // Same-origin relay of the documented SDP exchange; see src/app/api/realtime/sdp/route.ts.
      const res = await fetch("/api/realtime/sdp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientSecret: secret.clientSecret, sdp: offer.sdp }) });
      const data = await res.json().catch(() => ({}));
      if (this.closed) return;
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
            this.meter?.audio();
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
    this.meter?.open();
    this.flushTimer = setInterval(() => this.release(), 1000);
    // response.create with per-response instructions is the documented way to steer one reply;
    // it lands in the default conversation, so the persona remembers saying it.
    const line = this.scenario.aiPersona.openingLine.trim();
    if (line) this.send({ type: "response.create", response: { instructions: openingInstructions(this.scenario.aiPersona.name, line) } });
  }

  private message(raw: unknown) {
    if (this.closed || typeof raw !== "string") return;
    let ev: RealtimeServerEvent;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case "output_audio_buffer.started": this.set({ speaking: true }); break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": this.set({ speaking: false }); break;
      case "error":
        // Most realtime errors are per-event and non-fatal (e.g. cancelling an idle response). Expiry ends the call.
        if (ev.error?.code === "session_expired") return this.fail("The voice session reached OpenAI's time limit. Your transcript so far is kept.", "provider_error");
        console.warn("[realtime]", ev.error?.code ?? ev.error?.type ?? "error");
        return;
    }
    if (applyRealtimeEvent(this.asm, ev)) this.release();
  }

  private release(force = false) {
    for (const t of this.asm.flush(Date.now(), force)) {
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
    this.ending = true;
    if (this.view.phase !== "connected") return this.close(true);
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = false));
    if (this.audio) this.audio.muted = true;
    this.set({ phase: "ending", speaking: false });
    const until = Date.now() + END_GRACE_MS;
    const wait = () => {
      if (this.closed) return;
      if (this.asm.pending === 0 || Date.now() >= until) this.close(true);
      else this.endTimer = setTimeout(wait, 100);
    };
    wait();
  };

  private fail(msg: string, reason: MeterEndReason = "failed_connect") {
    if (this.closed) return;
    this.meter?.end(reason);
    this.release(true);
    const repSpoke = this.emittedUser > 0;
    this.h.onError(msg);
    // Once the rep has spoken the call still gets graded; before that, the trainer goes back to the briefing and keeps this error.
    this.close(repSpoke);
  }

  /** Releases everything exactly once. notify=false is for unmounts, which must not trigger grading. */
  close(notify: boolean) {
    if (this.closed) return;
    // Hang-up, unmount or a hang-up grace that ran out. A failure already reported its own reason (the meter ignores a second end).
    this.meter?.end("user_hangup");
    if (notify) this.release(true);
    this.closed = true;
    clearInterval(this.flushTimer);
    clearInterval(this.audioTimer);
    clearTimeout(this.endTimer);
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.mic?.getTracks().forEach((t) => t.stop());
    this.remote?.getTracks().forEach((t) => t.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => {});
    this.set({ phase: "closed", speaking: false });
    if (notify) this.h.onEnded();
  }
}

/** Voice session on the OpenAI Realtime API. Drop-in for the ElevenLabs VoiceSession. */
export default function RealtimeVoiceSession({ scenario, active, grading, onTurn, onEnded, onError, registerEnd, render }: {
  scenario: Scenario;
  active: boolean;
  grading: boolean;
  onTurn: (t: StoredTurn) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  registerEnd: (fn: () => void) => void;
  render: (v: VoiceRender) => React.ReactNode;
}) {
  const [view, setView] = useState<CallView>({ phase: "mic", speaking: false, muted: false });
  const callRef = useRef<RealtimeCall | null>(null);
  // Latest callbacks without restarting the call when the parent re-renders.
  const cb = useRef({ onTurn, onEnded, onError });
  useEffect(() => { cb.current = { onTurn, onEnded, onError }; });

  useEffect(() => {
    if (!active) return;
    const call = new RealtimeCall(scenario, {
      onTurn: (t) => cb.current.onTurn(t),
      onEnded: () => cb.current.onEnded(),
      onError: (m) => cb.current.onError(m),
      onView: (v) => { if (callRef.current === call) setView(v); },
    });
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

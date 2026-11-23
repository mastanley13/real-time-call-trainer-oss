/**
 * One source of truth for what a voice call says about the mic and the connection. The deck header (status pill),
 * the transcript empty state and the footer all read from voiceStatusCopy, so they can never disagree
 * (SAL-1039: the footer said "Mic is live" while the header was still waiting for the mic). Pure and client-safe.
 */

import { CallMeter, type MeterEndReason } from "./callMeter";

/** Sent with a voice error. connectFailed: the call never connected, so the trainer returns to the briefing even when a retry seeded rep turns. */
export interface VoiceErrorInfo { connectFailed?: boolean }

/** Whether a voice error sends the trainer back to the briefing: always before connect, else only when the rep has not spoken. */
export function leavesCallOnError(info: VoiceErrorInfo | undefined, repSpoke: boolean): boolean {
  return info?.connectFailed === true || !repSpoke;
}

/*
 * A deliberate hang-up before the call connects is not an error. Both engines end the attempt as failed_connect and
 * report it through onCancelled (never onEnded), so nothing is graded, not even turns seeded from a retry. The trainer
 * returns to the briefing with no banner: the rep chose to stop, and Start call is right there.
 */

/**
 * Which voice attempt owns the ElevenLabs SDK session. The SDK's callbacks belong to the hook, not to one session, so a
 * session started for an attempt that was then abandoned (connect timeout, hang-up before connect) can still connect,
 * speak or disconnect later. Each callback checks live() first; a late connect for an abandoned attempt is torn down.
 */
export class VoiceAttempts {
  private current = 0;
  private session = 0;
  private connectedSession = 0;
  /** Starts a new attempt and returns its id. */
  begin(): number { return ++this.current; }
  /** Abandons the current attempt: its late token is settled, its late session ignored and ended. */
  abandon(): void { this.current++; }
  isCurrent(id: number): boolean { return id === this.current; }
  /** Called right before startSession: the SDK session from now on belongs to attempt `id`. */
  bind(id: number): void { this.session = id; }
  /** True when the SDK session belongs to the current attempt, so its callbacks may act. */
  live(): boolean { return this.session !== 0 && this.session === this.current; }
  /** Records the SDK's onConnect for the current attempt's session. False, and nothing recorded, for an abandoned one. */
  connect(): boolean {
    if (!this.live()) return false;
    this.connectedSession = this.session;
    return true;
  }
  /**
   * True once onConnect ran for the current attempt. Set synchronously in the callback, so it is right before React
   * renders the SDK's connected status; the hang-up and the connect timeout read this, never the rendered status.
   */
  connected(): boolean { return this.live() && this.connectedSession === this.session; }
}

/** What ending an ElevenLabs attempt early needs from the session. */
export interface AttemptEndDeps {
  /** Ends the SDK session; safe when none has started. */
  endSession: () => void;
  /** Marks the attempt failed (its disconnect grades nothing) and settles the meter as failed_connect. */
  failAttempt: () => void;
}

/**
 * The ElevenLabs hang-up. Once connected (onConnect ran for this attempt, rendered or not) it only ends the session,
 * whose disconnect grades the call: "ended". Before that it abandons the attempt, settles it as failed_connect and
 * ends whatever started: "cancelled", so the trainer returns to the briefing without grading.
 */
export function elevenLabsHangUp(a: VoiceAttempts, d: AttemptEndDeps): "ended" | "cancelled" {
  if (a.connected()) { d.endSession(); return "ended"; }
  a.abandon();
  d.failAttempt();
  d.endSession();
  return "cancelled";
}

/** The SDK closed the call before it connected, with no error of its own. Offered with Retry voice and Switch to text. */
export const DISCONNECTED_BEFORE_CONNECT_MESSAGE = "The voice call closed before it connected. Check your mic and network, then retry voice or switch to text.";

/**
 * The ElevenLabs onDisconnect for the current attempt. Once connected it settles the meter as a hang-up or a drop and
 * grades. Before onConnect it is a failed connect, never graded (a retry may have seeded rep turns): settled as
 * failed_connect and reported once with the connect error, unless an earlier error already reported it (`failed`).
 */
export function elevenLabsDisconnect(a: VoiceAttempts, s: { failed: boolean; userEnded: boolean }): { meter: MeterEndReason; then: "grade" | "report_connect_failure" | "nothing" } {
  if (!a.connected()) return { meter: "failed_connect", then: s.failed ? "nothing" : "report_connect_failure" };
  return { meter: s.userEnded ? "user_hangup" : "network_drop", then: s.failed ? "nothing" : "grade" };
}

/**
 * The ElevenLabs session unmounted (the trainer left the call screen). Its SDK callbacks are ignored from then on, so
 * the meter is settled here: failed_connect when the current attempt never connected (releases the reservation, bills
 * 0), user_hangup once it did, as the Realtime call does on unmount. CallMeter.end is idempotent and stops the
 * heartbeat timers, so a meter a hang-up, timeout or error already ended is not ended twice. Then the SDK session ends.
 * A StrictMode remount runs this before any token is minted, when the meter has no callId and ending it does nothing.
 */
export function settleElevenLabsUnmount(a: VoiceAttempts, meter: { end(reason: MeterEndReason): void }, endSession: () => void): MeterEndReason {
  const reason: MeterEndReason = a.connected() ? "user_hangup" : "failed_connect";
  meter.end(reason);
  try { endSession(); } catch { /* already ended */ }
  return reason;
}

/**
 * The ElevenLabs connect timeout. Does nothing (false) once onConnect ran for this attempt, even if the timer fires
 * before the connected render clears it. Otherwise it stops the attempt like a pre-connect hang-up and returns true,
 * so the caller reports the timeout error.
 */
export function elevenLabsConnectTimeout(a: VoiceAttempts, d: AttemptEndDeps): boolean {
  if (a.connected()) return false;
  a.abandon();
  d.failAttempt();
  d.endSession();
  return true;
}

export type VoicePhase = "mic" | "connecting" | "connected" | "ending" | "closed";
export type StatusTone = "ok" | "signal" | "caution";
export type LampTone = StatusTone | "alert" | "off";

/** How long a voice call may wait for the mic and the connection before the attempt is stopped. */
export const CONNECT_TIMEOUT_MS = 20_000;
export const CONNECT_TIMEOUT_MESSAGE = "The voice call did not connect within 20 seconds, so we stopped it. Check that your browser can use the mic, then retry voice or switch to text.";

/**
 * A call the server minted after its attempt was abandoned (connect timeout, hang-up, unmount). Settle it as
 * failed_connect through the same end call the meter uses, so the server releases the reservation, then drop it.
 * Fire and forget; never throws.
 */
export function settleAbandonedCall(callId: unknown): void {
  if (typeof callId !== "string" || !callId) return;
  try { new CallMeter(callId, { onStop: () => {}, onGiveUp: () => {} }).end("failed_connect"); } catch { /* nothing to release */ }
}

/**
 * Seconds shown on the call clock. `elapsed` counts from Start; `connectedAt` is the elapsed value when the voice
 * call connected (null until then), so live-call time starts at 0:00 on connect.
 */
export function callClockSeconds(elapsed: number, connectedAt: number | null): number {
  return connectedAt === null ? 0 : Math.max(0, elapsed - connectedAt);
}

/**
 * The shared phase for an ElevenLabs call, whose SDK status has no mic step and no ended state of its own. Matches the
 * Realtime call: "ending" while hanging up, "closed" once it ended or is being graded, "connecting" only before the
 * first connect. `status` is the SDK's string ("connecting", "connected", "disconnecting", "disconnected", "error").
 */
export function elevenLabsPhase(status: string, s: { grading: boolean; wasConnected: boolean }): VoicePhase {
  if (s.grading) return "closed";
  if (status === "connected") return "connected";
  if (status === "disconnecting") return "ending";
  return s.wasConnected ? "closed" : "connecting";
}

export interface VoiceStatusCopy {
  /** The header status pill. */
  header: { label: string; tone: StatusTone };
  /** The transcript line shown before anyone has spoken. */
  body: string;
  /** The line under the transcript, with its lamp. */
  footer: { label: string; tone: LampTone };
  /** True only once the call is connected: the mic is live and the call clock runs. */
  connected: boolean;
}

export function voiceStatusCopy(phase: VoicePhase, muted: boolean, opts: { speaking?: boolean; name?: string } = {}): VoiceStatusCopy {
  const mutedNote = muted ? " Your mic is muted." : "";
  switch (phase) {
    case "mic":
      return {
        header: { label: "Waiting for your mic…", tone: "caution" },
        body: "Connecting the call…",
        footer: { label: `Waiting for your mic. Allow it if your browser asks.${mutedNote}`, tone: "caution" },
        connected: false,
      };
    case "connecting":
      return {
        header: { label: "Connecting…", tone: "caution" },
        body: "Connecting the call…",
        footer: { label: `Connecting the call. Your mic goes live once it connects.${mutedNote}`, tone: "caution" },
        connected: false,
      };
    case "ending":
      return { header: { label: "Wrapping up…", tone: "signal" }, body: "Wrapping up the call…", footer: { label: "Wrapping up the call…", tone: "signal" }, connected: false };
    case "closed":
      return { header: { label: "Call ended", tone: "caution" }, body: "The call ended.", footer: { label: "The call ended.", tone: "off" }, connected: false };
    case "connected": {
      const header = muted ? { label: "Muted", tone: "caution" as const }
        : opts.speaking ? { label: `${opts.name || "They"} ${opts.name ? "is" : "are"} speaking`, tone: "signal" as const }
        : { label: "Your turn", tone: "ok" as const };
      return {
        header,
        body: "Connected. Say hello when you hear them.",
        footer: muted ? { label: "Your mic is muted.", tone: "alert" } : { label: "Mic is live. Just talk; the transcript and coach follow along.", tone: "ok" },
        connected: true,
      };
    }
  }
}

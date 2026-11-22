/**
 * One source of truth for what a voice call says about the mic and the connection. The deck header (status pill),
 * the transcript empty state and the footer all read from voiceStatusCopy, so they can never disagree
 * (SAL-1039: the footer said "Mic is live" while the header was still waiting for the mic). Pure and client-safe.
 */

import { CallMeter } from "./callMeter";

/** Sent with a voice error. connectFailed: the call never connected, so the trainer returns to the briefing even when a retry seeded rep turns. */
export interface VoiceErrorInfo { connectFailed?: boolean }

/** Whether a voice error sends the trainer back to the briefing: always before connect, else only when the rep has not spoken. */
export function leavesCallOnError(info: VoiceErrorInfo | undefined, repSpoke: boolean): boolean {
  return info?.connectFailed === true || !repSpoke;
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

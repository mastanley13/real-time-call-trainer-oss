/**
 * Client side of voice metering, shared by both voice engines. It only reports events; the server decides
 * what a call costs from its own clock. Nothing is sent without a callId (demo mode, no database).
 *
 * Connected means the data channel is open AND the first remote audio arrived. Call `open()` and `audio()`
 * as each happens; the first heartbeat is sent when both have.
 *
 * Before that first heartbeat, any end is reported as failed_connect (the server settles it that way anyway: 0 s,
 * reservation released). Every exit before connect is handled by VoiceAttempt (src/lib/voiceAttempt.ts), which owns
 * the meter of its attempt.
 */

import { CAP_STOPPED_MESSAGE } from "./billingUi";

export type MeterEndReason = "user_hangup" | "network_drop" | "provider_error" | "server_error" | "failed_connect";

const HEARTBEAT_MS = 10_000;
/** A dropped connection that has not recovered after this long ends the call (rule 3). */
export const RECOVER_MS = 10_000;

export interface MeterHandlers {
  /** The server says the allowance ran out. */
  onStop: (message: string) => void;
  /** The connection did not recover in time. */
  onGiveUp: () => void;
  /** The call just connected (isConnected became true). */
  onConnected?: () => void;
}

export class CallMeter {
  private opened = false;
  private heard = false;
  private connected = false;
  private recovering = false;
  private ended = false;
  private timer?: ReturnType<typeof setInterval>;
  private recoverTimer?: ReturnType<typeof setTimeout>;

  constructor(private callId: string | undefined, private h: MeterHandlers) {}

  /**
   * The call connected: the data channel (or SDK) is open AND the first remote audio arrived, which is when the first
   * heartbeat is sent. Both engines use this one definition of connected. Tracked without a callId too (demo mode),
   * where nothing is sent.
   */
  get isConnected() { return this.connected; }

  open() { this.opened = true; this.maybeConnect(); }
  audio() { this.heard = true; this.maybeConnect(); }

  private maybeConnect() {
    if (this.ended || this.connected || !this.opened || !this.heard) return;
    this.connected = true;
    this.h.onConnected?.();
    if (!this.callId) return;
    void this.beat("connected");
    this.timer = setInterval(() => void this.beat(this.recovering ? "recovering" : "ok"), HEARTBEAT_MS);
  }

  /** WebRTC went to disconnected or failed: the server marks the wobble, and we give it 10 seconds to recover. */
  trouble() {
    if (!this.callId || this.ended || this.recovering) return;
    this.recovering = true;
    if (this.connected) void this.beat("recovering");
    this.recoverTimer = setTimeout(() => { if (this.recovering) this.h.onGiveUp(); }, RECOVER_MS);
  }

  /** The connection came back on its own: the same call continues. */
  recovered() {
    if (!this.recovering) return;
    this.recovering = false;
    clearTimeout(this.recoverTimer);
    if (this.connected) void this.beat("ok");
  }

  private async beat(state: "connected" | "ok" | "recovering") {
    try {
      const res = await fetch("/api/usage/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, state }) });
      if (!res.ok) return;
      const data = (await res.json().catch(() => ({}))) as { stop?: boolean; message?: string };
      if (data.stop && !this.ended) this.h.onStop(data.message || CAP_STOPPED_MESSAGE);
    } catch {
      /* a missed heartbeat is tolerated; the server ends the call 30 seconds after the last one */
    }
  }

  /**
   * Stops the timers and tells the server why the call ended. Safe to call more than once: only the first call sends.
   * Before the first heartbeat the reason sent is failed_connect, whatever ended it (a hang-up, a drop, a provider error).
   */
  end(reason: MeterEndReason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    clearTimeout(this.recoverTimer);
    if (!this.callId) return;
    const sent: MeterEndReason = this.connected ? reason : "failed_connect";
    void fetch("/api/usage/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, reason: sent }), keepalive: true }).catch(() => {});
  }
}

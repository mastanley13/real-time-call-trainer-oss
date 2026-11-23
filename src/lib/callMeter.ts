/**
 * Client side of voice metering, shared by both voice engines. It only reports events; the server decides
 * what a call costs from its own clock. Every method is a no-op without a callId (demo mode, no database).
 *
 * Connected means the data channel is open AND the first remote audio arrived. Call `open()` and `audio()`
 * as each happens; the first heartbeat is sent when both have.
 */

import { CAP_STOPPED_MESSAGE, FREE_CAP_WARNING_MESSAGE } from "./billingUi";

export type MeterEndReason = "user_hangup" | "network_drop" | "provider_error" | "server_error" | "failed_connect";

const HEARTBEAT_MS = 10_000;
/** A dropped connection that has not recovered after this long ends the call (rule 3). */
export const RECOVER_MS = 10_000;

/** What one heartbeat answer asks the call to do. */
export type HeartbeatAnswer = { kind: "stop"; message: string; freeCap: boolean } | { kind: "warn"; message: string } | { kind: "ok" };

/**
 * Reads a /api/usage/heartbeat answer. stop: the server has stopped and billed the call (freeCap: a Free call stopped at
 * its free minutes). warn: a Free call has about a minute of free minutes left (the server decides that from the call's
 * reservation; the client keeps no timer of its own).
 */
export function readHeartbeat(data: unknown): HeartbeatAnswer {
  const d = (data ?? {}) as { stop?: unknown; capWarning?: unknown; message?: unknown; freeCap?: unknown };
  const message = typeof d.message === "string" && d.message ? d.message : undefined;
  if (d.stop === true) return { kind: "stop", message: message ?? CAP_STOPPED_MESSAGE, freeCap: d.freeCap === true };
  if (d.capWarning === true) return { kind: "warn", message: message ?? FREE_CAP_WARNING_MESSAGE };
  return { kind: "ok" };
}

export interface MeterHandlers {
  /**
   * The server stopped the call (its minutes ran out, or the call length limit). Called once per call. freeCap: a Free
   * call stopped at its free minutes, which the caller ends the same way as a hang-up so the transcript is saved and graded.
   */
  onStop: (message: string, freeCap: boolean) => void;
  /** The connection did not recover in time. */
  onGiveUp: () => void;
  /** About a minute of a Free call's free minutes is left. Called at most once per call. */
  onWarn?: (message: string) => void;
}

/** How long a Free cap stop waits for the voice session to disconnect before it reports and ends the call anyway. */
export const CAP_STOP_DISCONNECT_MS = 3_000;

/**
 * Ends a voice session that the server stopped. A paid stop runs `paid` right away (the engine's own path, as before). A
 * Free cap stop hangs up the way the rep would, and reports the message and ends the call only once the session has
 * disconnected, so its last transcript turns are already in before the trainer decides between grading and the
 * briefing. If the disconnect never comes, it does both after CAP_STOP_DISCONNECT_MS. Once per call.
 */
export class CapStopEnd {
  private message?: string;
  private done = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private h: { hangUp: () => void; report: (message: string) => void; ended: () => void }, private timeoutMs = CAP_STOP_DISCONNECT_MS) {}

  stop(message: string, freeCap: boolean, paid: (message: string) => void) {
    if (!freeCap) return paid(message);
    if (this.message !== undefined) return;
    this.message = message;
    this.h.hangUp();
    this.timer = setTimeout(() => this.disconnected(), this.timeoutMs);
  }

  /** The session disconnected. True when this ended a Free cap stop, so the caller must not end the call again. */
  disconnected(): boolean {
    if (this.message === undefined) return false;
    if (this.done) return true;
    this.done = true;
    clearTimeout(this.timer);
    this.h.report(this.message);
    this.h.ended();
    return true;
  }
}

export class CallMeter {
  private opened = false;
  private heard = false;
  private connected = false;
  private recovering = false;
  private ended = false;
  private stopped = false;
  private warned = false;
  private timer?: ReturnType<typeof setInterval>;
  private recoverTimer?: ReturnType<typeof setTimeout>;

  constructor(private callId: string | undefined, private h: MeterHandlers) {}

  open() { this.opened = true; this.maybeConnect(); }
  audio() { this.heard = true; this.maybeConnect(); }

  private maybeConnect() {
    if (!this.callId || this.connected || !this.opened || !this.heard) return;
    this.connected = true;
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
      this.answer(readHeartbeat(await res.json().catch(() => ({}))));
    } catch {
      /* a missed heartbeat is tolerated; the server ends the call 30 seconds after the last one */
    }
  }

  private answer(a: HeartbeatAnswer) {
    if (this.ended || this.stopped) return;
    if (a.kind === "stop") {
      // Stop heartbeating at once: the server has settled the call, and a browser that keeps reporting after the stop
      // looks like a call that outlived its limit. end() still reports the end when the call closes.
      this.stopped = true;
      clearInterval(this.timer);
      clearTimeout(this.recoverTimer);
      this.h.onStop(a.message, a.freeCap);
    } else if (a.kind === "warn" && !this.warned) {
      this.warned = true;
      this.h.onWarn?.(a.message);
    }
  }

  /** Stops the timers and tells the server why the call ended. Safe to call more than once. */
  end(reason: MeterEndReason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    clearTimeout(this.recoverTimer);
    if (!this.callId) return;
    void fetch("/api/usage/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, reason }), keepalive: true }).catch(() => {});
  }
}

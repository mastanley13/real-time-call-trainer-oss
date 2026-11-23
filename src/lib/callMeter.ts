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

/**
 * A Free call ends itself after this many heartbeats in a row fail (a fetch error or a non-OK answer): about 30 seconds
 * without reaching the server, the same as the server's silence timeout. The server bills a silent Free call only up to
 * its last heartbeat (once per period), so an honest client must not keep the voice session running past that.
 */
export const MAX_FAILED_HEARTBEATS = 3;
/**
 * A Free call's heartbeat request is aborted after this long and counts as a failure, so a request the network leaves
 * pending cannot hold off the shutdown. Shorter than the 10 s interval, so each one settles before the next tick.
 */
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 8_000;
/** Shown when a Free call ended because its heartbeats kept failing. */
export const HEARTBEAT_LOST_MESSAGE = "The connection to the server dropped, so the call ended. Check your network. Your transcript so far is kept.";

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
  /**
   * MAX_FAILED_HEARTBEATS heartbeats in a row failed. Set only for a Free call (the mint answer's freeRule); the caller
   * ends the voice session as a network_drop and shows HEARTBEAT_LOST_MESSAGE. Without it (paid calls) a failed
   * heartbeat is tolerated as before. Called at most once per call.
   */
  onHeartbeatsLost?: () => void;
}

/** Grace on hang-up (both voice engines) so the trainee's last words still get transcribed before the call closes. */
export const END_GRACE_MS = 1500;
/**
 * Realtime only: how long a Free cap stop waits for the rep's uncommitted speech to be committed and transcribed before
 * the normal hang-up (which adds at most END_GRACE_MS). 4.5 s in all, well inside FREE_END_GRACE_SECONDS.
 */
export const CAP_STOP_SPEECH_FLUSH_MS = 3_000;
/** How long a Free cap stop waits for the voice session to disconnect before it reports and ends the call anyway. */
export const CAP_STOP_DISCONNECT_MS = 3_000;

/**
 * Ends a voice session that the server stopped. A paid stop runs `paid` right away (the engine's own path, as before).
 * A Free cap stop mutes the mic, then waits up to END_GRACE_MS for the rep's in-flight words to come back as a final
 * transcript (sooner if one lands), then hangs up. Its message is reported and the call ended only once the session
 * has disconnected, so every rep turn is in before the trainer decides between grading and the briefing. If the
 * disconnect never comes, both happen CAP_STOP_DISCONNECT_MS after the hang-up. At most 4.5 s in all, well inside the
 * server's FREE_END_GRACE_SECONDS. Once per call.
 */
export class CapStopEnd {
  private message?: string;
  private hungUp = false;
  private done = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private h: { mute?: () => void; hangUp: () => void; report: (message: string) => void; ended: () => void },
    private o: { flushMs?: number; timeoutMs?: number } = {},
  ) {}

  stop(message: string, freeCap: boolean, paid: (message: string) => void) {
    if (!freeCap) return paid(message);
    if (this.message !== undefined) return;
    this.message = message;
    this.h.mute?.();
    this.flushTimer = setTimeout(() => this.hangUpNow(), this.o.flushMs ?? END_GRACE_MS);
  }

  /** A final rep transcript arrived (call after recording the turn). During a Free stop's flush window it hangs up now. */
  userTranscript() {
    if (this.message !== undefined) this.hangUpNow();
  }

  private hangUpNow() {
    if (this.hungUp || this.done) return;
    this.hungUp = true;
    clearTimeout(this.flushTimer);
    this.h.hangUp();
    this.timer = setTimeout(() => this.disconnected(), this.o.timeoutMs ?? CAP_STOP_DISCONNECT_MS);
  }

  /** The session disconnected. True when this ended a Free cap stop, so the caller must not end the call again. */
  disconnected(): boolean {
    if (this.message === undefined) return false;
    if (this.done) return true;
    this.done = true;
    clearTimeout(this.flushTimer);
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
  private failedBeats = 0;
  private lost = false;
  /** A Free call's heartbeat in flight (see boundedBeat). */
  private pending?: { seq: number; controller: AbortController; timer: ReturnType<typeof setTimeout> };
  private requestSeq = 0;
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

  private heartbeatRequest(state: "connected" | "ok" | "recovering", signal?: AbortSignal) {
    return fetch("/api/usage/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, state }), ...(signal ? { signal } : {}) });
  }

  private beat(state: "connected" | "ok" | "recovering"): Promise<void> {
    return this.h.onHeartbeatsLost ? this.boundedBeat(state) : this.paidBeat(state);
  }

  /** A paid call's heartbeat, unchanged: no timeout, and a failed one is tolerated. */
  private async paidBeat(state: "connected" | "ok" | "recovering") {
    let res: Response;
    try {
      res = await this.heartbeatRequest(state);
    } catch {
      return this.failedBeat();
    }
    if (!res.ok) return this.failedBeat();
    this.failedBeats = 0;
    try {
      this.answer(readHeartbeat(await res.json().catch(() => ({}))));
    } catch {
      /* as before: a handler that throws does not reject the heartbeat timer's promise */
    }
  }

  /**
   * A Free call's heartbeat: one at a time, each bounded by HEARTBEAT_REQUEST_TIMEOUT_MS. A request that has no answer
   * (with its body read) by then is aborted and counts as a failure, so a network that leaves requests pending still
   * reaches the MAX_FAILED_HEARTBEATS shutdown. While a request is in flight no other heartbeat starts: that tick is
   * skipped, not counted, because the pending one settles (answer or timeout) within the timeout, which is shorter than
   * the interval. So every interval tick still makes one attempt, and 3 failures stay about 30 s of lost contact. An
   * out-of-band heartbeat (trouble, recovered) is skipped the same way; the next tick sends the current state. An answer
   * that arrives after its request timed out or was cancelled is ignored.
   */
  private async boundedBeat(state: "connected" | "ok" | "recovering") {
    if (this.pending || this.ended || this.stopped || this.lost) return;
    const seq = ++this.requestSeq;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (this.pending?.seq !== seq) return;
      this.pending = undefined;
      controller.abort();
      this.failedBeat();
    }, HEARTBEAT_REQUEST_TIMEOUT_MS);
    this.pending = { seq, controller, timer };
    /** True when this request still owns the pending slot (it neither timed out nor was cancelled), and releases it. */
    const settle = (): boolean => {
      if (this.pending?.seq !== seq) return false;
      clearTimeout(timer);
      this.pending = undefined;
      return true;
    };
    let body: unknown;
    try {
      const res = await this.heartbeatRequest(state, controller.signal);
      if (!res.ok) {
        if (settle()) this.failedBeat();
        return;
      }
      body = await res.json().catch(() => ({}));
    } catch {
      if (settle()) this.failedBeat();
      return;
    }
    if (!settle()) return; // timed out or cancelled while waiting: a late answer is ignored
    this.failedBeats = 0;
    try {
      this.answer(readHeartbeat(body));
    } catch {
      /* a handler that throws does not reject the heartbeat timer's promise */
    }
  }

  /** Aborts the heartbeat in flight, if any, and clears its timeout. Its answer, if it still comes, is ignored. */
  private cancelPending() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.controller.abort();
    this.pending = undefined;
  }

  /**
   * One heartbeat failed. A paid call tolerates it, as before: the server ends a call 30 seconds after the last one. A
   * Free call (onHeartbeatsLost set) ends after MAX_FAILED_HEARTBEATS in a row, so it never runs on unbilled.
   */
  private failedBeat() {
    this.failedBeats += 1;
    if (!this.h.onHeartbeatsLost || this.failedBeats < MAX_FAILED_HEARTBEATS) return;
    if (this.lost || this.ended || this.stopped) return;
    this.lost = true;
    clearInterval(this.timer);
    clearTimeout(this.recoverTimer);
    this.cancelPending();
    this.h.onHeartbeatsLost();
  }

  private answer(a: HeartbeatAnswer) {
    if (this.ended || this.stopped) return;
    if (a.kind === "stop") {
      // Stop heartbeating at once: the server has settled the call, and a browser that keeps reporting after the stop
      // looks like a call that outlived its limit. end() still reports the end when the call closes.
      this.stopped = true;
      clearInterval(this.timer);
      clearTimeout(this.recoverTimer);
      this.cancelPending();
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
    this.cancelPending();
    if (!this.callId) return;
    void fetch("/api/usage/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, reason }), keepalive: true }).catch(() => {});
  }
}

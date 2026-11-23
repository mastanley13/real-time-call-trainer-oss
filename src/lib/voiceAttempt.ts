/**
 * One voice call attempt, from Start until the call connects, shared by every voice engine (ElevenLabs in
 * src/components/call/elevenLabsStart.ts; OpenAI Realtime and GPT-Live in src/components/call/RealtimeVoiceSession.tsx).
 *
 * "Connected" has one definition everywhere: the attempt's meter is connected (CallMeter.isConnected: the data channel or
 * SDK is open AND the first remote audio arrived, which is when the first heartbeat goes out). Until then, every way the
 * attempt can end goes through ONE cancel() per attempt, which:
 *   1. marks the attempt cancelled (idempotent: a second cancel, or any cancel after connect, does nothing);
 *   2. reports failed_connect once if the server minted a callId (POST /api/usage/end, keepalive; nothing without one);
 *   3. tears down the provider session and media (the owner's teardown: Realtime aborts a pending SDP request and closes
 *      the peer connection and mic; ElevenLabs ends the SDK session, also one still connecting);
 *   4. makes every later callback of the attempt a no-op (owners check `live`), and a late connect is torn down;
 *   5. puts the call screen back to the briefing with a message, without grading (owner's onCancelled), except when
 *      there is no screen left (unmount, a superseded attempt).
 * The attempt-level page-hide observer lives from the attempt's start until the meter connects or the attempt ends,
 * with or without a callId.
 *
 * Every way an attempt can end or be abandoned before the meter connects (R: Realtime, L: GPT-Live, E: ElevenLabs;
 * metered and unmetered alike, since only step 2 depends on a callId):
 *
 * | #  | Path                                                        | Engines | cancel() exit | Screen                         |
 * |----|-------------------------------------------------------------|---------|---------------|--------------------------------|
 * | 1  | Rep hangs up: mic prompt, mint pending, connecting, or      | R L E   | hang_up       | ENDED_BEFORE_CONNECT_MESSAGE   |
 * |    | transport up with no remote audio yet                       |         |               |                                |
 * | 2  | Page hide (tab closed, navigation, back/forward cache) at   | R L E   | page_hide     | LEFT_BEFORE_CONNECT_MESSAGE    |
 * |    | any step before connect, mic prompt and mint included       |         |               |                                |
 * | 3  | Unmount (the trainer leaves the call screen). ElevenLabs    | R L E   | unmount       | none (no screen)               |
 * |    | waits one task, so a StrictMode remount carries on          |         |               |                                |
 * | 4  | Mic permission denied (R L: getUserMedia rejects; E: the    | R L E   | error         | the mic error message          |
 * |    | SDK start fails and calls onError)                          |         |               |                                |
 * | 5  | Mic permission still pending: no exit of its own; rows 1 to | R L E   | (1, 2 or 3)   | as that row; a stream that     |
 * |    | 3 apply, and a stream granted later is stopped              |         |               | arrives later is stopped       |
 * | 6  | Mint error (HTTP error, network failure, no secret or       | R L E   | error         | the server's or a fixed message|
 * |    | token). The route already closed any call it minted         |         |               |                                |
 * | 7  | Mint answer arrives after the attempt was cancelled         | R L E   | (already)     | unchanged; the callId is       |
 * |    |                                                             |         |               | reported at once, never started|
 * | 8  | Mint answer never reaches the page (tab closed first)       | R L E   | none possible | server reclaims after 45 s     |
 * | 9  | Session expired at the mint or the SDP exchange (401)       | R L     | sign_in       | redirect, or a message when    |
 * |    |                                                             |         |               | a newer sign-in exists         |
 * | 10 | Voice secret expired before connecting                      | R L     | error         | the expiry message             |
 * | 11 | SDP exchange error or network failure                       | R L     | error         | the provider message           |
 * | 12 | Provider error before connect (R: session_expired event;    | R E     | error         | the provider message           |
 * |    | E: SDK onError)                                             |         |               |                                |
 * | 13 | Transport closed before connect (R L: peer failed, data     | R L E   | error         | DROPPED_BEFORE_CONNECT_MESSAGE |
 * |    | channel closed, recovery timer gave up; L: session.closed;  |         |               |                                |
 * |    | E: SDK onDisconnect)                                        |         |               |                                |
 * | 14 | SDK startSession throws after the mint                      | E       | error         | the error message              |
 * | 15 | A new attempt starts while one is before connect (E: a new  | R L E   | superseded    | none (the new attempt owns it) |
 * |    | mint in the same mount; R L: a new RealtimeCall per mount,  |         | (R L: unmount)|                                |
 * |    | the old one is unmounted, row 3)                            |         |               |                                |
 * | 16 | Connect timeout                                             | -       | -             | none exists on this branch     |
 * | 17 | Late events of a cancelled attempt (connect, audio, message,| R L E   | (already)     | ignored; R: peer closed, SDP   |
 * |    | error, disconnect, SDP answer, mic stream)                  |         |               | aborted; E: late connect ended |
 *
 * After the meter connects, nothing here applies: hang-up, errors, drops, page hide and unmount follow the connected-call
 * paths unchanged (billing included), and the attempt is finish()ed when that call ends.
 */

import { CallMeter, type MeterHandlers } from "./callMeter";

/** Page hide before connect (row 2). Seen if the page comes back from the back/forward cache. */
export const LEFT_BEFORE_CONNECT_MESSAGE = "The call stopped because you left the page before it connected. Start the call again.";
/** Rep hung up before connect (row 1). */
export const ENDED_BEFORE_CONNECT_MESSAGE = "The call ended before it connected, so there is nothing to grade.";
/** Transport closed before connect (row 13). */
export const DROPPED_BEFORE_CONNECT_MESSAGE = "The voice connection closed before the call connected. Check your network and try again, or switch to Text.";

export type PreConnectExit = "hang_up" | "page_hide" | "unmount" | "error" | "sign_in" | "superseded";

export interface AttemptOwner {
  /** Tears down this attempt's provider session and media. Called once, by cancel(). */
  teardown: () => void;
  /** Back to the briefing with `message`, without grading. Not called for unmount or a superseded attempt. */
  onCancelled: (message: string) => void;
}

/**
 * Calls `fn` when the page is hidden (tab closed, navigated away, or put in the back/forward cache). Returns the
 * unsubscribe. A no-op outside a browser.
 *
 * While a mint request is pending there is no callId to report yet: if the answer still reaches the page, the minted call
 * is reported at once (row 7). If the page is gone first, nothing can report it (row 8); the server's safety net then
 * closes it on the user's next voice start once it is over NEVER_CONNECTED_RECLAIM_SECONDS (45 s) old with no heartbeat
 * (failed_connect, 0 s, 0 minutes).
 */
export function onPageHide(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  window.addEventListener("pagehide", fn);
  return () => { if (typeof window.removeEventListener === "function") window.removeEventListener("pagehide", fn); };
}

let lastAttemptId = 0;

export class VoiceAttempt {
  readonly id = ++lastAttemptId;
  private m = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
  private cancelled = false;
  private finished = false;
  private unlisten: () => void;

  /** The attempt starts now: the page-hide observer is installed before anything is awaited. */
  constructor(private owner: AttemptOwner) {
    this.unlisten = onPageHide(() => { this.cancel("page_hide"); });
  }

  /** This attempt's meter. A meter with no callId until the mint answers (and for an unmetered call). */
  get meter() { return this.m; }
  /** The one definition of connected (see the top of this file). */
  get connected() { return this.m.isConnected; }
  /** Callbacks of this attempt may act: neither cancelled nor finished. */
  get live() { return !this.cancelled && !this.finished; }
  get isCancelled() { return this.cancelled; }

  /**
   * The mint answered (callId undefined when unmetered or when the mint failed). Creates the attempt's meter. False when
   * the attempt was already cancelled: the callId is then reported as failed_connect at once and nothing may start.
   */
  minted(callId: string | undefined, handlers: MeterHandlers): boolean {
    this.m = new CallMeter(callId, { ...handlers, onConnected: () => { this.unlisten(); handlers.onConnected?.(); } });
    if (this.cancelled) {
      this.m.end("failed_connect");
      return false;
    }
    return true;
  }

  /**
   * The one cancellation for every exit before connect (see the table). False, doing nothing, when the attempt is
   * already cancelled or finished, or has connected (the caller then takes the connected-call path). `message` is the
   * screen text for error and sign_in exits; a function is evaluated after the teardown (sign_in navigates there).
   */
  cancel(exit: PreConnectExit, message?: string | (() => string | null)): boolean {
    if (this.cancelled || this.finished || this.m.isConnected) return false;
    this.cancelled = true;
    this.unlisten();
    this.m.end("failed_connect");
    this.owner.teardown();
    const text = exit === "hang_up" ? ENDED_BEFORE_CONNECT_MESSAGE
      : exit === "page_hide" ? LEFT_BEFORE_CONNECT_MESSAGE
      : exit === "unmount" || exit === "superseded" ? null
      : typeof message === "function" ? message() : message ?? null;
    if (text) this.owner.onCancelled(text);
    return true;
  }

  /** The connected call ended through its own path. Later callbacks of this attempt are ignored. */
  finish() {
    this.finished = true;
    this.unlisten();
  }
}

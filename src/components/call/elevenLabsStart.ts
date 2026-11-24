import { CallMeter, type MeterHandlers } from "@/lib/callMeter";
import { DROPPED_BEFORE_CONNECT_MESSAGE, VoiceAttempt } from "@/lib/voiceAttempt";

/** What /api/elevenlabs/token answers. Labels and numbers only, no model id. */
export interface TokenAnswer { token?: string; callId?: string; maxSeconds?: unknown; voiceTier?: unknown; nextCallStandard?: unknown; voiceTrial?: unknown }

/** The SDK callbacks one attempt passes to startSession. Each is bound to that attempt's id. */
export interface SessionCallbacks {
  onConnect: () => void;
  onMessage: (m: { message: string; role: string }) => void;
  onError: (message: unknown) => void;
  onDisconnect: () => void;
}

/**
 * The ElevenLabs side of a voice call, kept outside React (like RealtimeCall). One per VoiceSession mount; every token
 * request starts a new VoiceAttempt (src/lib/voiceAttempt.ts), and every exit before the call connects goes through that
 * attempt's one cancel(): see the table at the top of voiceAttempt.ts for each path. After the call connected, the SDK's
 * own end events apply as before.
 */
export class ElevenLabsStart {
  private attempt?: VoiceAttempt;
  private unmounted = false;
  private placeholder = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });

  /**
   * onEnded: the connected call ended (the trainer grades it). onError: a connected call's provider error.
   * onCancelled: the attempt ended before connect: back to the briefing with the message, without grading.
   * endSession: ends the SDK session, also one still connecting (harmless when there is none).
   */
  constructor(private h: { onEnded: () => void; onError: (msg: string) => void; onCancelled: (msg: string) => void; endSession: () => void }) {}

  /** The current attempt's meter (a meter with no callId before the first token request). */
  get meter() { return this.attempt?.meter ?? this.placeholder; }

  /** The current attempt was canceled before it connected. */
  get isCancelled() { return !!this.attempt?.isCancelled; }

  /** Mounted (again, under StrictMode): the attempt carries on. */
  mount() { this.unmounted = false; }

  /**
   * Unmounted (row 3). Cancels the current attempt if it has not connected. The cancel waits one task: a StrictMode
   * remount comes back in the same task and the attempt carries on; a real unmount does not come back. A connected call
   * is left to the SDK, whose provider ends the session on unmount and reports through onDisconnect.
   */
  unmount() {
    this.unmounted = true;
    setTimeout(() => { if (this.unmounted) this.attempt?.cancel("unmount"); }, 0);
  }

  /**
   * Asks the server for a token (it reserves the minutes and returns the callId) in a new attempt; an older attempt still
   * before connect is superseded (row 15). Null when the attempt was canceled while the request was in flight (rows 1,
   * 2, 3); the minted call is then reported as failed_connect at once (row 7). Throws on a failed mint (row 6), which the
   * token route has already closed on the server; the caller passes the message to failed().
   */
  async mint(url: string, handlers: MeterHandlers): Promise<(TokenAnswer & { attempt: number }) | null> {
    this.attempt?.cancel("superseded");
    const attempt = new VoiceAttempt({ teardown: () => this.h.endSession(), onCancelled: (m) => this.h.onCancelled(m) });
    this.attempt = attempt;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
    if (!attempt.minted(typeof data.callId === "string" ? data.callId : undefined, handlers)) return null;
    if (this.unmounted) {
      attempt.cancel("unmount");
      return null;
    }
    return { ...data, attempt: attempt.id };
  }

  /** The callbacks for startSession, bound to `attemptId` (from mint). None of them acts once the attempt is over. */
  sessionCallbacks(attemptId: number, cb: { onTurn: (t: { role: "user" | "assistant"; text: string }) => void; userEnded: () => boolean }): SessionCallbacks {
    const current = () => (this.attempt?.id === attemptId && this.attempt.live ? this.attempt : null);
    return {
      onConnect: () => {
        const a = current();
        // A canceled or superseded attempt that connects late is ended at once (row 17).
        if (!a) return this.h.endSession();
        a.meter.open();
      },
      onMessage: ({ message, role }) => {
        const a = current();
        if (!a) return;
        // ElevenLabs has no packet-level event; the first agent message is the first remote audio.
        if (role !== "user") a.meter.audio();
        cb.onTurn({ role: role === "user" ? "user" : "assistant", text: message });
      },
      onError: (m) => {
        const a = current();
        if (!a) return;
        const msg = typeof m === "string" ? m : "Voice connection error";
        if (a.cancel("error", msg)) return; // rows 4, 12: before connect
        a.meter.end("provider_error");
        this.h.onError(msg);
      },
      onDisconnect: () => {
        const a = current();
        if (!a) return;
        if (a.cancel("error", DROPPED_BEFORE_CONNECT_MESSAGE)) return; // row 13: before connect
        a.meter.end(cb.userEnded() ? "user_hangup" : "network_drop");
        a.finish();
        this.h.onEnded();
      },
    };
  }

  /** The start failed: a failed mint (row 6) or startSession throwing after it (row 14). */
  failed(message: string) { this.attempt?.cancel("error", message); }

  /**
   * The rep hung up. Before connect (row 1) the attempt is canceled and the screen goes back to the briefing at once,
   * without waiting for an SDK callback that may never come. After connect it is the normal connected hang-up: the
   * caller ends the SDK session, and onDisconnect reports user_hangup and ends the screen, as before.
   */
  hangUp() { this.attempt?.cancel("hang_up"); }
}

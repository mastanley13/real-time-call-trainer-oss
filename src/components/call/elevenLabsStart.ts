import { CallMeter, LEFT_BEFORE_CONNECT_MESSAGE, onPageHide, type MeterHandlers } from "@/lib/callMeter";

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
 * The part of an ElevenLabs voice call before it connects, kept outside React (like RealtimeCall). One per VoiceSession
 * mount; each token starts a new attempt with its own id, and the SDK callbacks are bound to it (sessionCallbacks).
 *
 * Before the call connects, the same rules as RealtimeCall apply to every exit, through one cancel():
 * - hang-up: cancelled, failed_connect reported once, and the call screen ends at once (onEnded; nothing said, so back to
 *   the briefing without grading). The SDK suppresses its error callback when endSession comes during a pending
 *   connection and does not always call onDisconnect, so the screen is not left waiting for it.
 * - page hide (closed tab, navigation, back/forward cache): cancelled, failed_connect reported once, and the screen goes
 *   back to the briefing with LEFT_BEFORE_CONNECT_MESSAGE (onError, no grading).
 * - unmount: cancelled and failed_connect reported once; no screen callback (there is no screen).
 * A cancelled attempt is final: its SDK session is ended, every later callback (connect, message, error, disconnect) is
 * ignored, and a late onConnect ends that SDK session again. A token that arrives for it is reported and never started.
 *
 * "Before connect" means meter.isConnected is false (SDK connected AND first agent audio arrived), for every exit and on
 * both engines; a call whose SDK connected but has not yet played audio is still before connect. After the call
 * connected, the SDK's own end events apply as before.
 */
export class ElevenLabsStart {
  /** The metered call, once the token route answered with a callId. A no-op meter until then. */
  meter = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
  private attempt = 0;
  private cancelled = false;
  private unmounted = false;
  /** The page was hidden (closed, navigated away) while the token request was pending. */
  private hiddenDuringMint = false;
  /** The screen was ended (onEnded or the page-hide error): every later SDK callback is ignored. */
  private screenEnded = false;

  /**
   * onEnded: ends the call screen. With nothing said by the rep (always the case before connect) the trainer goes back
   * to the briefing without grading. onError: shows an error; before the rep spoke it also returns to the briefing.
   * endSession: ends the SDK session, also one that is still connecting (harmless when there is none).
   */
  constructor(private h: { onEnded: () => void; onError: (msg: string) => void; endSession: () => void }) {}

  /** Mounted (again, under StrictMode): the attempt carries on. */
  mount() { this.unmounted = false; }

  /**
   * Unmounted. A call that did not connect is cancelled like any other pre-connect exit. The cancel waits one task: a
   * StrictMode remount comes back in the same task and the attempt carries on; a real unmount does not come back. A
   * connected call is left to the SDK, whose provider ends the session on unmount and reports through onDisconnect.
   */
  unmount() {
    this.unmounted = true;
    setTimeout(() => { if (this.unmounted && !this.meter.isConnected) this.cancel(); }, 0);
  }

  /** True when this attempt must not start or show anything more: hung up, unmounted, page hidden, or screen ended. */
  get isCancelled() { return this.unmounted || this.cancelled || this.hiddenDuringMint || this.screenEnded; }

  /**
   * Asks the server for a token (it reserves the minutes and returns the callId) and starts a new attempt. Null when the
   * call was cancelled while the request was in flight (hang-up, unmount, page hide); the minted call is then reported as
   * failed_connect at once. A token whose answer never reaches the page (the tab closed first) cannot be reported from
   * here; the server reclaims it on the next voice start once it is over 45 s old with no heartbeat (see onPageHide in
   * callMeter.ts). Throws on a failed mint, which the token route has already closed on the server.
   */
  async mint(url: string, handlers: MeterHandlers): Promise<(TokenAnswer & { attempt: number }) | null> {
    const id = ++this.attempt;
    this.meter = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
    this.cancelled = false;
    this.hiddenDuringMint = false;
    // A page hide while the token is on its way cancels the attempt at once (as RealtimeCall does during its mic prompt and
    // mint); the token, if it still arrives, is then reported and never started.
    const unlisten = onPageHide(() => {
      if (id !== this.attempt) return;
      this.hiddenDuringMint = true;
      this.pageHidden(id);
    });
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
      this.meter = new CallMeter(typeof data.callId === "string" ? data.callId : undefined, { ...handlers, onAbandon: () => this.pageHidden(id) });
      if (this.isCancelled) {
        this.cancel(); // reports this token's call: failed_connect, once
        return null;
      }
      return { ...data, attempt: id };
    } finally {
      unlisten();
    }
  }

  /** The callbacks for startSession, bound to `attempt` (from mint). None of them acts once the attempt is cancelled. */
  sessionCallbacks(attempt: number, cb: { onTurn: (t: { role: "user" | "assistant"; text: string }) => void; userEnded: () => boolean }): SessionCallbacks {
    const live = () => attempt === this.attempt && !this.cancelled && !this.screenEnded;
    return {
      onConnect: () => {
        // A cancelled attempt that connects late is ended at once; it was already reported and its screen is gone.
        if (!live()) return this.h.endSession();
        this.meter.open();
      },
      onMessage: ({ message, role }) => {
        if (!live()) return;
        // ElevenLabs has no packet-level event; the first agent message is the first remote audio.
        if (role !== "user") this.meter.audio();
        cb.onTurn({ role: role === "user" ? "user" : "assistant", text: message });
      },
      onError: (m) => {
        if (!live()) return;
        this.meter.end("provider_error");
        this.h.onError(typeof m === "string" ? m : "Voice connection error");
      },
      onDisconnect: () => {
        if (!live()) return;
        this.meter.end(cb.userEnded() ? "user_hangup" : "network_drop");
        this.endScreen();
      },
    };
  }

  /** Starting the SDK session failed after the mint: report it (failed_connect unless it had connected). */
  failed() { this.meter.abandon(); }

  /**
   * The rep hung up. Before the call connected (meter.isConnected: SDK connected AND the first agent audio arrived; also
   * while the SDK is connected but silent) the attempt is cancelled and the screen ends here, without waiting for an SDK
   * callback that may never come. After that it is the normal connected hang-up: the caller ends the SDK session, and the
   * SDK's onDisconnect reports user_hangup and ends the screen, as before.
   */
  hangUp() {
    if (this.meter.isConnected) return;
    this.cancel();
    this.endScreen();
  }

  /**
   * The page was hidden while attempt `id` had not connected (token on its way, or the SDK connecting; the meter has
   * then already reported failed_connect). Cancelled for good, and back to the briefing with the reason, no grading.
   */
  private pageHidden(id: number) {
    if (id !== this.attempt || this.meter.isConnected) return;
    this.cancel();
    if (!this.unmounted) this.endScreenLeft();
  }

  /**
   * The one pre-connect cancellation (hang-up, page hide, unmount): final for this attempt. Reports failed_connect once
   * (the meter sends only its first end, and nothing for a call that already connected) and ends the SDK session, also
   * one still connecting. Every later callback of the attempt is ignored (sessionCallbacks).
   */
  private cancel() {
    this.meter.abandon();
    if (this.cancelled) return;
    this.cancelled = true;
    this.h.endSession();
  }

  private endScreen() {
    if (this.screenEnded) return;
    this.screenEnded = true;
    this.h.onEnded();
  }

  private endScreenLeft() {
    if (this.screenEnded) return;
    this.screenEnded = true;
    this.h.onError(LEFT_BEFORE_CONNECT_MESSAGE);
  }
}

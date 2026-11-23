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
 * The part of an ElevenLabs voice call before it connects, kept outside React (like RealtimeCall) so every way out of
 * it reports the end to the server once, as failed_connect: a hang-up, unmount or page hide while the token is on its
 * way, a hang-up or page hide while the SDK is still connecting, a start that fails after the mint. One per VoiceSession
 * mount. After the call connects, the meter's own end events apply as before.
 *
 * It also owns ending the call screen. A hang-up before the SDK reported a connection ends the screen from here, at
 * once: the SDK suppresses its error callback when endSession comes during a pending connection and does not always
 * call onDisconnect, so waiting for it could leave the rep stuck.
 *
 * Each token starts an attempt with its own id, and the SDK callbacks are bound to it (sessionCallbacks). Once an attempt
 * is cancelled (hang-up or page hide before connect) or the screen has ended, every callback from it is ignored: no turn,
 * no meter event, no error, no second screen end. A late onConnect from a cancelled attempt ends that SDK session.
 */
export class ElevenLabsStart {
  /** The metered call, once the token route answered with a callId. A no-op meter until then. */
  meter = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
  private attempt = 0;
  private cancelled = false;
  private unmounted = false;
  /** The page was hidden (closed, navigated away) while the token request was pending. */
  private hiddenDuringMint = false;
  /** The SDK reported the connection (onConnect). From then on its onDisconnect ends the screen, as before. */
  private sdkConnected = false;
  /** The screen was ended (onEnded or the page-hide error): every later SDK callback is ignored. */
  private screenEnded = false;

  /**
   * onEnded: ends the call screen. With nothing said by the rep (always the case before connect) the trainer goes back
   * to the briefing without grading. onError: shows an error; before the rep spoke it also returns to the briefing.
   * endSession: ends the SDK session, also one that is still connecting.
   */
  constructor(private h: { onEnded: () => void; onError: (msg: string) => void; endSession: () => void }) {}

  /** Mounted (again, under StrictMode): a later token answer may start the call. */
  mount() { this.unmounted = false; }

  /** Unmounted: a token still on its way is reported and never started; a call that did not connect is reported now. */
  unmount() {
    this.unmounted = true;
    this.meter.abandon();
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
    this.cancelled = false;
    this.hiddenDuringMint = false;
    this.sdkConnected = false;
    const unlisten = onPageHide(() => { this.hiddenDuringMint = true; });
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
      this.meter = new CallMeter(typeof data.callId === "string" ? data.callId : undefined, { ...handlers, onAbandon: () => this.abandon(id) });
      if (this.isCancelled) {
        this.meter.end("failed_connect");
        // Hidden but still here (the back/forward cache): back to the briefing. A hang-up already ended the screen.
        if (this.hiddenDuringMint && !this.unmounted) this.endScreenLeft();
        return null;
      }
      return { ...data, attempt: id };
    } finally {
      unlisten();
    }
  }

  /** The callbacks for startSession, bound to `attempt` (from mint). */
  sessionCallbacks(attempt: number, cb: { onTurn: (t: { role: "user" | "assistant"; text: string }) => void; userEnded: () => boolean }): SessionCallbacks {
    const live = () => attempt === this.attempt && !this.cancelled && !this.screenEnded;
    return {
      onConnect: () => {
        // A cancelled attempt that connects late is ended at once; it was already reported and its screen is gone.
        if (!live()) return this.h.endSession();
        this.sdkConnected = true;
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
   * The rep hung up. Before the call connected this is a failed connect, reported now. Before the SDK reported a
   * connection (token still on its way, or the SDK still connecting) the attempt is cancelled and the screen ends here,
   * since no SDK callback is guaranteed. After onConnect, the SDK's onDisconnect ends it as before.
   */
  hangUp() {
    this.meter.abandon();
    if (this.sdkConnected) return;
    this.cancelled = true;
    this.endScreen();
  }

  /**
   * The page was hidden while attempt `id` was still connecting (the meter has reported failed_connect). The attempt is
   * cancelled for good and its SDK session ended, so a page restored from the back/forward cache cannot connect it, and
   * the screen goes back to the briefing with a message.
   */
  private abandon(id: number) {
    if (id !== this.attempt) return;
    this.cancelled = true;
    this.h.endSession();
    this.endScreenLeft();
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

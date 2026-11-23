import { CallMeter, onPageHide, type MeterEndReason } from "@/lib/callMeter";

type MeterHandlers = ConstructorParameters<typeof CallMeter>[1];

/** What /api/elevenlabs/token answers. Labels and numbers only, no model id. */
export interface TokenAnswer { token?: string; callId?: string; maxSeconds?: unknown; voiceTier?: unknown; nextCallStandard?: unknown; voiceTrial?: unknown }

/**
 * The part of an ElevenLabs voice call before it connects, kept outside React (like RealtimeCall) so every way out of
 * it reports the end to the server once, as failed_connect: a hang-up, unmount or page hide while the token is on its
 * way, a hang-up while the SDK is still connecting, a start that fails after the mint, or the page going away. One per
 * VoiceSession mount. After the call connects, the meter's own end events apply as before.
 *
 * It also owns ending the call screen. A hang-up before the SDK reported a connection ends the screen from here, at
 * once: the SDK suppresses its error callback when endSession comes during a pending connection and does not always
 * call onDisconnect, so waiting for it could leave the rep stuck. Any later disconnect or error callback from that
 * attempt is then ignored, so the screen ends exactly once.
 */
export class ElevenLabsStart {
  /** The metered call, once the token route answered with a callId. A no-op meter until then. */
  meter = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
  private unmounted = false;
  private hungUp = false;
  /** The page was hidden (closed, navigated away) while the token request was pending. */
  private hiddenDuringMint = false;
  /** The SDK reported the connection (onConnect). From then on its onDisconnect ends the screen, as before. */
  private sdkConnected = false;
  /** onEnded was called: every later SDK callback from this attempt is ignored. */
  private screenEnded = false;

  /**
   * onEnded: ends the call screen. With nothing said by the rep (always the case before connect) the trainer goes back
   * to the briefing without grading. onError: shows a provider error.
   */
  constructor(private h: { onEnded: () => void; onError: (msg: string) => void }) {}

  /** Mounted (again, under StrictMode): a later token answer may start the call. */
  mount() { this.unmounted = false; }

  /** Unmounted: a token still on its way is reported and never started; a call that did not connect is reported now. */
  unmount() {
    this.unmounted = true;
    this.meter.abandon();
  }

  /** True when this attempt must not start or show anything more: hung up, unmounted, page hidden, or screen ended. */
  get isCancelled() { return this.unmounted || this.hungUp || this.hiddenDuringMint || this.screenEnded; }

  /**
   * Asks the server for a token (it reserves the minutes and returns the callId). Null when the call was cancelled while
   * the request was in flight (hang-up, unmount, page hide); the minted call is then reported as failed_connect at once.
   * A token whose answer never reaches the page (the tab closed first) cannot be reported from here; the server reclaims
   * it on the next voice start once it is over 45 s old with no heartbeat (see onPageHide in callMeter.ts). Throws on a
   * failed mint, which the token route has already closed on the server.
   */
  async mint(url: string, handlers: MeterHandlers): Promise<TokenAnswer | null> {
    const unlisten = onPageHide(() => { this.hiddenDuringMint = true; });
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
      this.meter = new CallMeter(typeof data.callId === "string" ? data.callId : undefined, handlers);
      if (this.isCancelled) {
        this.meter.end("failed_connect");
        // Hidden but still here (the back/forward cache): end the screen too. A hang-up already did; an unmount has none.
        if (this.hiddenDuringMint && !this.unmounted) this.endScreen();
        return null;
      }
      return data;
    } finally {
      unlisten();
    }
  }

  /** The SDK's onConnect. */
  connected() {
    this.sdkConnected = true;
    this.meter.open();
  }

  /** The SDK's onDisconnect: reports the end and ends the screen, unless this attempt already ended it. */
  disconnected(reason: MeterEndReason) {
    if (this.screenEnded) return;
    this.meter.end(reason);
    this.endScreen();
  }

  /** The SDK's onError: reports the end and shows the error, unless this attempt already ended the screen. */
  providerError(msg: string) {
    if (this.screenEnded) return;
    this.meter.end("provider_error");
    this.h.onError(msg);
  }

  /** Starting the SDK session failed after the mint: report it (failed_connect unless it had connected). */
  failed() { this.meter.abandon(); }

  /**
   * The rep hung up. Before the call connected this is a failed connect, reported now. Before the SDK reported a
   * connection (token still on its way, or the SDK still connecting) the screen ends here too, since no SDK callback is
   * guaranteed. After onConnect, the SDK's onDisconnect ends it as before.
   */
  hangUp() {
    this.meter.abandon();
    if (this.sdkConnected) return;
    this.hungUp = true;
    this.endScreen();
  }

  private endScreen() {
    if (this.screenEnded) return;
    this.screenEnded = true;
    this.h.onEnded();
  }
}

import { CallMeter } from "@/lib/callMeter";

type MeterHandlers = ConstructorParameters<typeof CallMeter>[1];

/** What /api/elevenlabs/token answers. Labels and numbers only, no model id. */
export interface TokenAnswer { token?: string; callId?: string; maxSeconds?: unknown; voiceTier?: unknown; nextCallStandard?: unknown; voiceTrial?: unknown }

/**
 * The part of an ElevenLabs voice call before it connects, kept outside React (like RealtimeCall) so every way out of
 * it reports the end to the server once, as failed_connect: a hang-up or unmount while the token is on its way, a
 * hang-up while the SDK is still connecting, a start that fails after the mint, or the page going away. One per
 * VoiceSession mount. After the call connects, the meter's own end events apply as before.
 */
export class ElevenLabsStart {
  /** The metered call, once the token route answered with a callId. A no-op meter until then. */
  meter = new CallMeter(undefined, { onStop: () => {}, onGiveUp: () => {} });
  private tokenPending = false;
  private cancelled = false;

  /** onEnded: a hang-up during the token request ends the call screen (there is no session to disconnect yet). */
  constructor(private h: { onEnded: () => void }) {}

  /** Mounted (again, under StrictMode): a later token answer may start the call. */
  mount() { this.cancelled = false; }

  /** Unmounted: a token still on its way is reported and never started; a call that did not connect is reported now. */
  unmount() {
    this.cancelled = true;
    this.meter.abandon();
  }

  /**
   * Asks the server for a token (it reserves the minutes and returns the callId). Null when the call was cancelled while
   * the request was in flight; the minted call is then reported as failed_connect at once. Throws on a failed mint,
   * which the token route has already closed on the server.
   */
  async mint(url: string, handlers: MeterHandlers): Promise<TokenAnswer | null> {
    this.tokenPending = true;
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
      this.meter = new CallMeter(typeof data.callId === "string" ? data.callId : undefined, handlers);
      if (this.cancelled) {
        this.meter.end("failed_connect");
        return null;
      }
      return data;
    } finally {
      this.tokenPending = false;
    }
  }

  /** Starting the SDK session failed after the mint: report it (failed_connect unless it had connected). */
  failed() { this.meter.abandon(); }

  get isCancelled() { return this.cancelled; }

  /**
   * The rep hung up. Before the call connected this is a failed connect, reported now: the SDK does not always call
   * onDisconnect for a session it was still starting when endSession came. During the token request there is no
   * session to end, so the call is cancelled and the call screen ends.
   */
  hangUp() {
    this.meter.abandon();
    if (this.tokenPending && !this.cancelled) {
      this.cancelled = true;
      this.h.onEnded();
    }
  }
}

/**
 * Client side of voice metering, shared by both voice engines. It only reports events; the server decides
 * what a call costs from its own clock. Every method is a no-op without a callId (demo mode, no database).
 *
 * Connected means the data channel is open AND the first remote audio arrived. Call `open()` and `audio()`
 * as each happens; the first heartbeat is sent when both have.
 *
 * Before that first heartbeat, any end is reported as failed_connect (the server settles it that way anyway: 0 s,
 * reservation released), and leaving the page reports it too, so a failed first try never holds the rep's minutes.
 */

import { CAP_STOPPED_MESSAGE } from "./billingUi";

export type MeterEndReason = "user_hangup" | "network_drop" | "provider_error" | "server_error" | "failed_connect";

const HEARTBEAT_MS = 10_000;
/** A dropped connection that has not recovered after this long ends the call (rule 3). */
export const RECOVER_MS = 10_000;

/** Shown if the page comes back (the back/forward cache) after it was hidden while the call was still connecting. */
export const LEFT_BEFORE_CONNECT_MESSAGE = "The call stopped because you left the page before it connected. Start the call again.";

export interface MeterHandlers {
  /** The server says the allowance ran out. */
  onStop: (message: string) => void;
  /** The connection did not recover in time. */
  onGiveUp: () => void;
  /**
   * The page was hidden before the call connected, and the meter has just reported failed_connect. The owner must cancel
   * the connection attempt for good (provider connection, mic, call screen): if the page comes back from the
   * back/forward cache, nothing from this attempt may resume, since the server has closed it at 0 seconds.
   */
  onAbandon?: () => void;
}

/**
 * Calls `fn` when the page is hidden for good (tab closed, navigated away, or put in the back/forward cache). Returns
 * the unsubscribe. A no-op outside a browser.
 *
 * Used while a mint request is pending, when there is no callId to report yet: if the answer still reaches this page,
 * the minted call is ended at once as failed_connect. If the page is gone before the answer arrives, nothing can report
 * it; the server's safety net then closes it on the user's next voice start once it is over
 * NEVER_CONNECTED_RECLAIM_SECONDS (45 s) old with no heartbeat (failed_connect, 0 s, 0 minutes).
 */
export function onPageHide(fn: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  window.addEventListener("pagehide", fn);
  return () => { if (typeof window.removeEventListener === "function") window.removeEventListener("pagehide", fn); };
}

export class CallMeter {
  private opened = false;
  private heard = false;
  private connected = false;
  private recovering = false;
  private ended = false;
  private timer?: ReturnType<typeof setInterval>;
  private recoverTimer?: ReturnType<typeof setTimeout>;
  private unlistenPageHide: () => void = () => {};

  constructor(private callId: string | undefined, private h: MeterHandlers) {
    // Closing the tab or navigating away before the call connected: report it now, with a keepalive request, and have
    // the owner cancel the attempt so a page restored from the back/forward cache cannot connect it unmetered.
    if (callId) this.unlistenPageHide = onPageHide(() => this.pageHidden());
  }

  private pageHidden() {
    if (this.ended || this.connected) return;
    this.end("failed_connect");
    this.h.onAbandon?.();
  }

  open() { this.opened = true; this.maybeConnect(); }
  audio() { this.heard = true; this.maybeConnect(); }

  /**
   * The call is going away (unmount) without a reason of its own. Before it connected, that is a failed
   * connect and is reported now. A connected call is left to its own end event or the server's heartbeat timeout.
   */
  abandon() {
    if (!this.connected) this.end("failed_connect");
  }

  private maybeConnect() {
    if (!this.callId || this.ended || this.connected || !this.opened || !this.heard) return;
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
    this.unlistenPageHide();
    const sent: MeterEndReason = this.connected ? reason : "failed_connect";
    void fetch("/api/usage/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: this.callId, reason: sent }), keepalive: true }).catch(() => {});
  }
}

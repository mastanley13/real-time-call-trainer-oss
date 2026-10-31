/**
 * Client side of voice metering, shared by both voice engines. It only reports events; the server decides
 * what a call costs from its own clock. Every method is a no-op without a callId (demo mode, no database).
 *
 * Connected means the data channel is open AND the first remote audio arrived. Call `open()` and `audio()`
 * as each happens; the first heartbeat is sent when both have.
 */

export type MeterEndReason = "user_hangup" | "network_drop" | "provider_error" | "server_error" | "failed_connect";

const HEARTBEAT_MS = 10_000;
/** A dropped connection that has not recovered after this long ends the call (rule 3). */
export const RECOVER_MS = 10_000;

export class CallMeter {
  private opened = false;
  private heard = false;
  private connected = false;
  private recovering = false;
  private ended = false;
  private timer?: ReturnType<typeof setInterval>;
  private recoverTimer?: ReturnType<typeof setTimeout>;

  /** onStop: the server says the allowance ran out. onGiveUp: the connection did not recover in time. */
  constructor(private callId: string | undefined, private h: { onStop: (message: string) => void; onGiveUp: () => void }) {}

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
      const data = (await res.json().catch(() => ({}))) as { stop?: boolean; message?: string };
      if (data.stop && !this.ended) this.h.onStop(data.message || "You have used all your voice minutes for this period.");
    } catch {
      /* a missed heartbeat is tolerated; the server ends the call 30 seconds after the last one */
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

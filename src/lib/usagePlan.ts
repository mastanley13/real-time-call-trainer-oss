/**
 * Plans, caps and voice-minute rules. Pure and client-safe: no database, no env.
 * Pricing locked Oct 30, 2026: Free 20 min, Pro 200 min, Team 300 pooled min per seat (minimum 3 seats).
 * There are no overages. A call hard-stops when the cap is reached.
 */

export type PlanTier = "free" | "pro" | "team";

export const FREE_MINUTES = 20;
export const PRO_MINUTES = 200;
export const TEAM_MINUTES_PER_SEAT = 300;
export const TEAM_MIN_SEATS = 3;
export const TEAM_MAX_SEATS = 500;
/** Premium voice may use at most this share of the plan's minutes. */
export const PREMIUM_VOICE_SHARE = 0.6;

/** A call longer than this is ended by the server regardless of the cap. */
export const MAX_CALL_SECONDS = 24 * 60 * 60;
/** A failure that ends a call this early is credited back. */
export const DROP_CREDIT_SECONDS = 30;
/** Last heartbeat plus this long ends a call whose client went silent. */
export const HEARTBEAT_TIMEOUT_SECONDS = 30;
/** How long a client has to open the data channel after the server minted the session. */
export const CONNECT_WINDOW_SECONDS = 15 * 60;

export function isPlanTier(v: unknown): v is PlanTier {
  return v === "free" || v === "pro" || v === "team";
}

/** Minutes a plan grants per period. Seats only matter for Team. */
export function capFor(plan: PlanTier, seats = 1): number {
  if (plan === "team") return Math.max(TEAM_MIN_SEATS, Math.floor(seats)) * TEAM_MINUTES_PER_SEAT;
  return plan === "pro" ? PRO_MINUTES : FREE_MINUTES;
}

export function premiumVoiceCap(planCap: number): number {
  return Math.floor(planCap * PREMIUM_VOICE_SHARE);
}

// ---- Rounding and call outcome -------------------------------------------------------------

/** Billable minutes for a call: every started minute counts. 60 s is 1 minute, 61 s is 2. */
export function billedMinutes(billableSeconds: number): number {
  return billableSeconds > 0 ? Math.ceil(billableSeconds / 60) : 0;
}

/** Seconds between connect and end, never negative. Whole seconds, rounded down. */
export function billableSecondsBetween(connectedAt: Date | null, endedAt: Date): number {
  if (!connectedAt) return 0;
  return Math.max(0, Math.floor((endedAt.getTime() - connectedAt.getTime()) / 1000));
}

export type CallEndReasonId =
  | "user_hangup" | "network_drop" | "provider_error" | "server_error"
  | "cap_reached" | "max_duration" | "heartbeat_timeout" | "failed_connect";

/** Reasons a client may report. The rest are decided by the server. */
export const CLIENT_END_REASONS = ["user_hangup", "network_drop", "provider_error", "server_error", "failed_connect"] as const;

/** Failures on our side or the provider's, or the network's. A hang-up, a cap stop or a timeout is not a failure. */
const FAILURE_REASONS: ReadonlySet<CallEndReasonId> = new Set(["network_drop", "provider_error", "server_error"]);

export type CallOutcome = "failed_connect" | "dropped_credited" | "billed";

export interface CallSettlement {
  outcome: CallOutcome;
  billableSeconds: number;
  /** Minutes charged before any credit. */
  grossMinutes: number;
  /** Minutes given back for a failure within the first 30 seconds. */
  creditMinutes: number;
  /** grossMinutes minus creditMinutes: what the call costs the allowance. */
  netMinutes: number;
  /** The reason actually recorded: cap_reached or max_duration when the server clamped the call. */
  endReason: CallEndReasonId;
}

/**
 * Rules 3 to 8 and 11 in one place. `remainingMinutes` is what the allowance had left when the call
 * ended; a call can never bill more than that, so a cap stop bills exactly what was left.
 */
export function settleCall(input: {
  connectedAt: Date | null;
  endedAt: Date;
  reason: CallEndReasonId;
  remainingMinutes: number;
}): CallSettlement {
  const { connectedAt, endedAt, reason } = input;
  if (!connectedAt) {
    return { outcome: "failed_connect", billableSeconds: 0, grossMinutes: 0, creditMinutes: 0, netMinutes: 0, endReason: "failed_connect" };
  }
  let seconds = billableSecondsBetween(connectedAt, endedAt);
  let endReason = reason;
  if (seconds > MAX_CALL_SECONDS) {
    seconds = MAX_CALL_SECONDS;
    endReason = "max_duration";
  }
  const remaining = Math.max(0, Math.floor(input.remainingMinutes));
  if (billedMinutes(seconds) > remaining) {
    seconds = remaining * 60;
    endReason = "cap_reached";
  }
  const gross = billedMinutes(seconds);
  // Only a failure within the window is credited. A user hang-up at 5 seconds still costs a minute.
  const credited = FAILURE_REASONS.has(endReason) && seconds <= DROP_CREDIT_SECONDS;
  return {
    outcome: credited ? "dropped_credited" : "billed",
    billableSeconds: seconds,
    grossMinutes: gross,
    creditMinutes: credited ? gross : 0,
    netMinutes: credited ? 0 : gross,
    endReason,
  };
}

/** Seconds a call may still run before the server stops it, given what the allowance had left. */
export function secondsUntilCap(remainingMinutes: number, elapsedSeconds: number): number {
  return Math.max(0, Math.max(0, remainingMinutes) * 60 - elapsedSeconds);
}

// ---- Monthly period ------------------------------------------------------------------------

export interface UsagePeriod { start: Date; end: Date }

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** The anchor's day and time in a month `offset` months after the anchor's month; the 29th to 31st clamp to month end. */
function boundary(anchor: Date, offset: number): Date {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return new Date(Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/**
 * The usage period containing `now`, anchored to the signup date (rule 13). Resets monthly with no
 * rollover; an anchor on the 29th to 31st resets on the last day of shorter months, then returns to its day.
 */
export function periodFor(anchorAt: Date, now: Date): UsagePeriod {
  if (now.getTime() < anchorAt.getTime()) return { start: anchorAt, end: boundary(anchorAt, 1) };
  let n = (now.getUTCFullYear() - anchorAt.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchorAt.getUTCMonth());
  while (boundary(anchorAt, n).getTime() > now.getTime()) n -= 1;
  while (boundary(anchorAt, n + 1).getTime() <= now.getTime()) n += 1;
  return { start: boundary(anchorAt, n), end: boundary(anchorAt, n + 1) };
}

/**
 * The next time the anchor day occurs after `now`, as unix seconds, for Stripe's billing_cycle_anchor.
 * Null when today is already the anchor day or it is under an hour away: the subscription then
 * simply anchors to now, which lands on the same day, and Stripe needs a future time anyway.
 */
export function nextAnchorUnix(anchorAt: Date, now: Date): number | null {
  const { start, end } = periodFor(anchorAt, now);
  if (start.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return null;
  const secs = Math.floor(end.getTime() / 1000);
  return secs - Math.floor(now.getTime() / 1000) >= 3600 ? secs : null;
}

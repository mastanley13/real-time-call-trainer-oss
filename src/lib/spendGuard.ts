import "server-only";

/**
 * Hard spend kill switch for the routes that call paid providers (OpenAI Realtime, the coach,
 * grading and the persona wizard).
 *
 * PAID_FEATURES_ENABLED=false turns them all off at once: they answer 503 `paid_features_off`
 * and text calls fall back to the scripted caller. Unset or any other value leaves them on.
 *
 * DAILY_REALTIME_MINUTES_CAP sets a ceiling on voice minutes per UTC day. Each realtime session
 * reserves REALTIME_MINUTES_PER_CALL against it when its client secret is minted, because the
 * server never sees when a WebRTC call ends. Once the day's reservations reach the cap, every
 * paid route is off until midnight UTC. Unset means no cap.
 *
 * NOTE: like rateLimit.ts, the counter is in memory and per server instance, so on serverless
 * hosts the cap is best-effort. PAID_FEATURES_ENABLED=false is the switch that always holds.
 */

/** Minutes reserved per voice call. Calls run longer than the 10-minute secret, so this is an estimate. */
export const REALTIME_MINUTES_PER_CALL = 10;

let day = "";
let reservedMinutes = 0;

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

function rollDay(now: number) {
  const today = utcDay(now);
  if (today !== day) {
    day = today;
    reservedMinutes = 0;
  }
}

export function paidFeaturesEnabled(): boolean {
  return process.env.PAID_FEATURES_ENABLED?.trim().toLowerCase() !== "false";
}

/** The daily voice-minute cap, or null when unset or not a whole number of minutes. */
export function dailyRealtimeMinutesCap(): number | null {
  const raw = process.env.DAILY_REALTIME_MINUTES_CAP?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export function realtimeMinutesReserved(now = Date.now()): number {
  rollDay(now);
  return reservedMinutes;
}

function capReached(now: number): boolean {
  const cap = dailyRealtimeMinutesCap();
  return cap !== null && realtimeMinutesReserved(now) >= cap;
}

/** True when paid routes may call their provider right now. */
export function paidFeaturesAvailable(now = Date.now()): boolean {
  return paidFeaturesEnabled() && !capReached(now);
}

/**
 * Reserves one voice call's minutes against today's cap. Returns false, and reserves nothing,
 * when paid features are off or the call would go over the cap.
 */
export function reserveRealtimeCall(now = Date.now()): boolean {
  if (!paidFeaturesAvailable(now)) return false;
  const cap = dailyRealtimeMinutesCap();
  if (cap !== null && reservedMinutes + REALTIME_MINUTES_PER_CALL > cap) return false;
  reservedMinutes += REALTIME_MINUTES_PER_CALL;
  return true;
}

/** Gives a reservation back when the call never started (the upstream mint failed). */
export function releaseRealtimeCall(now = Date.now()) {
  rollDay(now);
  reservedMinutes = Math.max(0, reservedMinutes - REALTIME_MINUTES_PER_CALL);
}

/** The 503 every paid route returns while the switch is off or the day's cap is used up. */
export function paidFeaturesOffResponse(): Response {
  const off = !paidFeaturesEnabled();
  return Response.json(
    {
      error: off ? "paid_features_off" : "daily_cap_reached",
      message: off
        ? "AI features are paused on this server. Text calls still work with the scripted caller."
        : "Today's AI practice budget is used up. Text calls still work with the scripted caller, and AI features come back at midnight UTC.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** Returns the 503 when paid routes are off, else null. Same calling style as ipLimitResponse. */
export function paidFeaturesGuard(now = Date.now()): Response | null {
  return paidFeaturesAvailable(now) ? null : paidFeaturesOffResponse();
}

/** Test hook: forget today's reservations. */
export function resetSpendGuard() {
  day = "";
  reservedMinutes = 0;
}

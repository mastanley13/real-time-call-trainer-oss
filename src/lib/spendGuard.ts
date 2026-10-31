import "server-only";

/**
 * Hard spend kill switch for the routes that call paid providers (OpenAI Realtime, ElevenLabs,
 * the coach, grading and re-grading, the persona wizard and the Models connection check).
 *
 * PAID_FEATURES_ENABLED=false turns them all off at once: they answer 503 `paid_features_off`
 * and text calls fall back to the scripted caller. Unset or any other value leaves them on.
 *
 * DAILY_REALTIME_MINUTES_CAP sets a ceiling on voice minutes per UTC day. Each voice call
 * (an OpenAI Realtime client secret or an ElevenLabs conversation token) reserves
 * REALTIME_MINUTES_PER_CALL against it when its credential is minted, because the server never
 * sees when a WebRTC call ends. Once the day's reservations reach the cap, paid routes refuse new
 * work until midnight UTC. The one exception is /api/realtime/sdp: it only connects a call whose
 * minutes were already reserved, so it obeys the kill switch but not the cap. Unset means no cap.
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

/** One voice call's minutes, tied to the UTC day they were reserved against. */
export interface RealtimeReservation {
  readonly day: string;
  readonly minutes: number;
  released: boolean;
}

/**
 * Reserves one voice call's minutes against today's cap. Returns null, and reserves nothing,
 * when paid features are off or the call would go over the cap.
 */
export function reserveRealtimeCall(now = Date.now()): RealtimeReservation | null {
  if (!paidFeaturesAvailable(now)) return null;
  rollDay(now);
  const cap = dailyRealtimeMinutesCap();
  if (cap !== null && reservedMinutes + REALTIME_MINUTES_PER_CALL > cap) return null;
  reservedMinutes += REALTIME_MINUTES_PER_CALL;
  return { day, minutes: REALTIME_MINUTES_PER_CALL, released: false };
}

/**
 * Gives a reservation back when the call never started (the upstream mint failed). Only that
 * reservation's day is credited: if midnight passed meanwhile, its day's counter is already gone,
 * so nothing comes off the new day's reservations. Releasing twice does nothing.
 */
export function releaseRealtimeCall(reservation: RealtimeReservation, now = Date.now()) {
  if (reservation.released) return;
  reservation.released = true;
  rollDay(now);
  if (reservation.day !== day) return;
  reservedMinutes = Math.max(0, reservedMinutes - reservation.minutes);
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

/**
 * The kill switch alone, without the daily cap. Only for steps that finish a voice call whose
 * minutes are already reserved (the SDP exchange), so the call that used the last minutes connects.
 */
export function paidFeaturesSwitchGuard(): Response | null {
  return paidFeaturesEnabled() ? null : paidFeaturesOffResponse();
}

/** Test hook: forget today's reservations. */
export function resetSpendGuard() {
  day = "";
  reservedMinutes = 0;
}

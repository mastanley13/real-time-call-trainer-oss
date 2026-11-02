import "server-only";
import { prisma } from "@/lib/db";

/**
 * The durable half of the spend kill switch: one SpendState row (id "global") that the hourly spend monitor
 * trips and that every paid route reads through paidFeaturesGuard (src/lib/spendGuard.ts).
 *
 * Reads are cached per server instance for STATE_CACHE_MS, so a trip written by the cron reaches every
 * instance within that window without a database round trip on each request.
 *
 * Without DATABASE_URL there is no row and nothing to read: the switch reads as clear, because the monitor
 * cannot run there either. With a database, a failed read counts as tripped (fail closed). A paid route that
 * cannot tell whether spend is over budget refuses rather than spending; the database being down breaks
 * sign-in and metering anyway, so this costs little.
 */

export const STATE_ID = "global";
export const STATE_CACHE_MS = 15_000;

export interface SpendTrip {
  /** Paid routes are off until a platform admin clears the trip. */
  tripped: boolean;
  /** The UTC day whose voice ceiling was reached, if any. Only today's matters. */
  dailyCapDay: string | null;
}

const CLEAR: SpendTrip = { tripped: false, dailyCapDay: null };
let cached: { at: number; value: SpendTrip } | null = null;

const hasDatabase = () => Boolean(process.env.DATABASE_URL);

/** The current trip state, cached for STATE_CACHE_MS. Never throws. */
export async function readSpendTrip(now = Date.now()): Promise<SpendTrip> {
  if (!hasDatabase()) return CLEAR;
  if (cached && now - cached.at < STATE_CACHE_MS) return cached.value;
  let value: SpendTrip;
  try {
    const row = await prisma.spendState.findUnique({ where: { id: STATE_ID }, select: { tripped: true, dailyCapDay: true } });
    value = row ? { tripped: row.tripped, dailyCapDay: row.dailyCapDay } : CLEAR;
  } catch (e) {
    // Error class only: Prisma messages can carry connection details.
    console.error("[spend] state read failed; paid features stay off until it succeeds", e instanceof Error ? e.name : "unknown");
    value = { tripped: true, dailyCapDay: null };
  }
  cached = { at: now, value };
  return value;
}

/** Overwrites this instance's cached view after it wrote the row itself. */
export function rememberSpendTrip(value: SpendTrip, now = Date.now()) {
  cached = { at: now, value };
}

/**
 * Records that today's voice ceiling was reached, so every instance refuses paid work for the rest of the
 * UTC day (not just the one whose in-memory counter hit the cap). Fire and forget; errors are logged.
 */
export async function recordDailyCeiling(day: string, now = Date.now()): Promise<void> {
  if (cached) cached = { at: cached.at, value: { ...cached.value, dailyCapDay: day } };
  if (!hasDatabase()) return;
  try {
    const row = await prisma.spendState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, dailyCapDay: day },
      update: { dailyCapDay: day },
      select: { tripped: true, dailyCapDay: true },
    });
    rememberSpendTrip(row, now);
    console.warn(JSON.stringify({ event: "spend.daily_ceiling", day }));
  } catch (e) {
    console.error("[spend] could not record the daily ceiling", e instanceof Error ? e.name : "unknown");
  }
}

/** Test hook: forget the cached state. */
export function resetSpendStateCache() {
  cached = null;
}

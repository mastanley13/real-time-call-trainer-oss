import "server-only";
import { prisma } from "./db";
import { endCall, voiceEnforcement } from "./usage";
import { hangupCall, hangupLeased } from "./providerHangup";

/** Most calls acted on in one run, so a backlog cannot stampede the provider. */
export const SWEEP_BATCH = 50;
/** Rows read per run to find them. A row with a provider call and no recorded hangup is normally a call in progress. */
const SWEEP_SCAN = 500;
/** A hangup that keeps failing is retried for this long after mint, then left alone. */
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SweepSummary { scanned: number; due: number; hungUp: number; settled: number }

/**
 * The durable half of server-side hangup. It needs no browser request: it reads the TrainerSession rows (the schedule
 * lives in the database, so a restart loses nothing) and, for each call that still has a provider call and no
 * recorded hangup, and is past its deadline, or ended with a server reason, or open and silent (see `voiceEnforcement`),
 * hangs the provider call up and settles the call if it is still open (max_duration, or heartbeat_timeout for a silent
 * one, on the server clock, through the same settlement as everything else). A second run finds nothing to do.
 * One failing call never stops the others; logs carry error names and status codes only.
 */
export async function enforceVoiceDeadlines(now = new Date(), batch = SWEEP_BATCH): Promise<SweepSummary> {
  const rows = await prisma.trainerSession.findMany({
    where: { providerCallId: { not: null }, providerHangupAt: null, createdAt: { gte: new Date(now.getTime() - SWEEP_WINDOW_MS) } },
    orderBy: { createdAt: "asc" },
    take: SWEEP_SCAN,
  });
  // A call whose hangup is in flight (an unexpired lease) is left to that attempt; once the lease expires it is due again.
  const due = rows.flatMap((s) => { const why = hangupLeased(s.providerHangupLeaseAt, now) ? null : voiceEnforcement(s, now); return why ? [{ s, why }] : []; }).slice(0, batch);
  const summary: SweepSummary = { scanned: rows.length, due: due.length, hungUp: 0, settled: 0 };
  await Promise.all(due.map(async ({ s, why }) => {
    try {
      if (await hangupCall(s.id, now)) summary.hungUp += 1;
      if (!s.endedAt && why !== "ended") {
        await endCall(s.userId, s.id, why, now);
        summary.settled += 1;
      }
    } catch (e) {
      console.error("[cron/enforce-voice-deadlines] call failed", e instanceof Error ? e.name : "unknown");
    }
  }));
  return summary;
}

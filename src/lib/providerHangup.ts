import "server-only";
import { prisma } from "./db";
import { realtimeKey } from "./realtime";
import { hangupProviderCall } from "./realtimeCalls";

/** A hangup attempt holds the call this long. If the process dies mid-attempt, the next trigger or sweep retries after it. */
export const PROVIDER_HANGUP_LEASE_MS = 2 * 60 * 1000;

/** True while another attempt's lease on this call is still running. */
export const hangupLeased = (leaseAt: Date | null | undefined, now: Date): boolean =>
  !!leaseAt && now.getTime() - leaseAt.getTime() < PROVIDER_HANGUP_LEASE_MS;

/**
 * Hangs up the provider call stored on a TrainerSession. An attempt first takes a lease (a conditional update on
 * providerHangupLeaseAt, so concurrent callers send one request; an expired lease is taken over with a compare and swap),
 * sends the hangup, and records providerHangupAt only after the provider accepts it (200, or 404 for a call that is
 * already gone). A recorded hangup is never sent again. A failed attempt releases its lease so the next trigger retries; if
 * that write fails too, or the process dies, the lease simply expires.
 *
 * Best effort by design: it never throws, logs status codes only, and does nothing for a call with no provider id
 * (text, ElevenLabs, or metering off) or when no OpenAI key is configured. True when the provider accepted a hangup.
 */
export async function hangupCall(callId: string, now = new Date()): Promise<boolean> {
  try {
    const key = realtimeKey();
    if (!key) return false;
    const row = await prisma.trainerSession.findUnique({ where: { id: callId }, select: { providerCallId: true, providerHangupAt: true, providerHangupLeaseAt: true } });
    if (!row?.providerCallId || row.providerHangupAt) return false;
    if (hangupLeased(row.providerHangupLeaseAt, now)) return false;
    const taken = await prisma.trainerSession.updateMany({
      where: { id: callId, providerHangupAt: null, providerHangupLeaseAt: row.providerHangupLeaseAt ?? null },
      data: { providerHangupLeaseAt: now },
    });
    if (taken.count === 0) return false;
    const done = await hangupProviderCall(key, row.providerCallId);
    if (done) await prisma.trainerSession.updateMany({ where: { id: callId, providerHangupAt: null }, data: { providerHangupAt: now } });
    else await prisma.trainerSession.updateMany({ where: { id: callId, providerHangupLeaseAt: now }, data: { providerHangupLeaseAt: null } }).catch(() => null);
    return done;
  } catch (e) {
    console.error("[realtime/hangup]", e instanceof Error ? e.name : "unknown error");
    return false;
  }
}

/** Hangs up several calls (settled together, after their transaction committed). Never throws. */
export async function hangupCalls(callIds: string[]): Promise<void> {
  await Promise.all(callIds.map((id) => hangupCall(id)));
}

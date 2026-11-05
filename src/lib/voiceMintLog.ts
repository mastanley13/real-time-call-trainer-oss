import "server-only";
import { prisma } from "./db";
import type { VoiceTier } from "./voiceTier";

/**
 * The trusted mint writer. Right after /api/realtime/session got a client secret from OpenAI for a METERED call, it
 * records on that call's own TrainerSession row the model it actually minted and the effective voice tier the call runs
 * on. This does not depend on the browser ever saving the call (an abandoned call is logged too) and it is separate from
 * paid accounting (engineTier and the Premium minutes are the meter's; a comped call is billed on standard but runs, and
 * is logged as, premium).
 *
 * Only the caller's own row, only a metered row (it has an allowance), and the model only once: a later write never
 * replaces it. The model id never leaves the server; nothing here is returned to a client.
 *
 * Unmetered calls have no row at mint, so their model reaches the database only through the sealed receipt on save
 * (src/lib/mintReceipt.ts, POST /api/transcripts).
 */
export async function recordMintedVoice(userId: string, callId: string, minted: { model: string; tier: VoiceTier }): Promise<boolean> {
  const tier = minted.tier === "premium" ? "premium" : "standard";
  const r = await prisma.trainerSession.updateMany({
    where: { id: callId, userId, allowanceId: { not: null }, realtimeModel: null },
    data: { realtimeModel: minted.model.slice(0, 80), voiceTier: tier },
  });
  return r.count === 1;
}

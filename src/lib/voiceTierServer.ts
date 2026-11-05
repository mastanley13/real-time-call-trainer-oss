import "server-only";
import { prisma } from "./db";
import { getCapabilities } from "./serverConfig";
import { effectiveVoiceTier, type VoiceTier } from "./voiceTier";
import { resolveTierModel } from "./voiceModels";
import { storedOrDefaultTier } from "./tenant";

export const voiceModelFor = (tier: VoiceTier): string => resolveTierModel(tier, process.env);

/**
 * The tier the user's next call runs on, read from the database on every mint so a change applies
 * to the next call. Premium only when the organization is comped and set to premium. Demo mode,
 * database-less installs, users without an organization and a failed lookup all get Standard:
 * the call still starts, on the cheaper model.
 */
export async function orgVoiceTierForUser(userId: string): Promise<VoiceTier> {
  const caps = getCapabilities();
  if (caps.demoMode || !caps.database) return "standard";
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { organization: { select: { voiceModelTier: true, voiceModelComped: true } } } });
    return effectiveVoiceTier(storedOrDefaultTier(row?.organization?.voiceModelTier), row?.organization?.voiceModelComped);
  } catch (e) {
    console.error("[voiceTier] lookup failed, using standard", e instanceof Error ? e.name : "unknown error");
    return "standard";
  }
}

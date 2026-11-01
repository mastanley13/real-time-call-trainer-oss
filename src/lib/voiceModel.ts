/**
 * Picks which voice model a call runs on. Pure and client-safe: the session route and the briefing both use it,
 * so what the briefing shows is what the route will send. Names come from realtimeModelFor (serverConfig.ts),
 * the only place that decides them; this file only chooses between two given names.
 */

export type VoiceTier = "premium" | "standard";

/** An unknown tier (minutes are not metered, so there is no entitlement to check) runs premium. */
export function pickVoiceModel(models: { premium: string; standard: string }, tier?: VoiceTier): string {
  return tier === "standard" ? models.standard : models.premium;
}

/** The model the next call will use, from /api/config capabilities and the tier /api/usage reports. */
export function voiceModelFromCaps(caps: { realtimeModel?: string; realtimeModelStandard?: string } | null | undefined, tier?: VoiceTier): string | undefined {
  if (!caps?.realtimeModel) return undefined;
  return pickVoiceModel({ premium: caps.realtimeModel, standard: caps.realtimeModelStandard ?? caps.realtimeModel }, tier);
}

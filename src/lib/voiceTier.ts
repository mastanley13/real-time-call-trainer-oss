/**
 * Per-organization voice quality for OpenAI Realtime calls. Pure and client-safe: the team page
 * imports the tier names and labels. It holds no model ids; the tier to model mapping is server-only
 * (src/lib/voiceModels.ts). The UI only ever shows "Standard" and "Premium".
 *
 * Not billing: Organization.premiumVoice and TrainerSession.engineTier are the Stripe-metered Premium Voice
 * add-on (src/lib/usage.ts) and are not read or changed here. Organization.voiceModelTier and
 * Organization.voiceModelComped only pick which Realtime model a call is minted on.
 */

export const VOICE_TIERS = ["standard", "premium"] as const;
export type VoiceTier = (typeof VOICE_TIERS)[number];

export const VOICE_TIER_LABELS: Record<VoiceTier, string> = { standard: "Standard", premium: "Premium" };

/** The stored column: null, empty, "standard" or anything unknown is Standard. Only "premium" is Premium. */
export function normalizeVoiceTier(raw: unknown): VoiceTier {
  return typeof raw === "string" && raw.trim().toLowerCase() === "premium" ? "premium" : "standard";
}

/** Only the organization's owner or a platform admin may change its voice quality. Managers and trainees may not. */
export function canSetVoiceTier(role: string | null | undefined, isPlatformAdmin = false): boolean {
  return isPlatformAdmin || role === "owner";
}

/**
 * The tier a call actually runs on. Premium only when the organization is comped AND its tier is premium;
 * a stored premium tier on an org that is not comped (or no longer comped) still mints Standard.
 */
export function effectiveVoiceTier(tier: unknown, comped: boolean | null | undefined): VoiceTier {
  return comped === true && normalizeVoiceTier(tier) === "premium" ? "premium" : "standard";
}

/**
 * Who may change the tier: an owner of a comped organization, or a platform admin for any organization.
 * Owners of an organization that is not comped, managers and trainees may not.
 */
export function canEditVoiceTier(role: string | null | undefined, isPlatformAdmin: boolean, comped: boolean | null | undefined): boolean {
  return canSetVoiceTier(role, isPlatformAdmin) && (comped === true || isPlatformAdmin);
}

/**
 * The tier /api/realtime/session mints a call on. Exactly three ways onto Premium:
 * - the organization is comped AND set to premium (`orgTier`, from effectiveVoiceTier), or
 * - the usage meter started this call on the paid Premium Voice entitlement (`paidPremium`): PREMIUM_VOICE_ON_SALE
 *   exactly "true", an active (not trialing) subscription with the add-on and a period that has not ended, and at least
 *   one Premium minute left. beginCall decides that from the database; a stored add-on flag alone never qualifies, or
 * - the usage meter claimed this Free organization's one Premium trial call for this call (`trialSample`):
 *   PREMIUM_TRIAL_SAMPLE_ON exactly "true" and an atomic, permanent claim on the organization (src/lib/premiumTrial.ts).
 * Everything else is Standard. This only picks the model; minute caps and engineTier are the meter's.
 */
export function mintVoiceTier(orgTier: VoiceTier, paid: { paidPremium: boolean; trialSample?: boolean }): VoiceTier {
  return orgTier === "premium" || paid.paidPremium || paid.trialSample === true ? "premium" : "standard";
}

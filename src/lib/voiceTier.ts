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
 * The tier /api/realtime/session mints a call on. The organization's effective tier (comped gate) decides,
 * with one exception that keeps today's billing intact: a metered call that the usage meter started on the
 * paid Premium Voice engine (Organization.premiumVoice / User.premiumVoice, within its 60% share) keeps the
 * Premium model it is paying for. Without metering the engine is always "premium" by default, so it is ignored.
 * The engine and its minute caps are untouched here; this only picks the model.
 */
export function mintVoiceTier(orgTier: VoiceTier, paid: { metered: boolean; engine: "premium" | "standard" }): VoiceTier {
  return orgTier === "premium" || (paid.metered && paid.engine === "premium") ? "premium" : "standard";
}

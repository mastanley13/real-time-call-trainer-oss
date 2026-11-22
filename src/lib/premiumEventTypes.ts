/**
 * Premium Voice event names and payloads, shared by the server sink (src/lib/billingEvents.ts) and the browser seam
 * below. Client-safe. No external telemetry: nothing leaves the app unless a sink sends it. The registered GHL sink
 * forwards only voice_cap_hit, and only while GHL events are on (src/lib/ghlWebhook.ts).
 *
 * - premium_upsell_viewed {surface}: a locked Premium control or the add-on offer was shown (browser).
 * - premium_add_started: an owner asked for the prorated preview of adding Premium to a subscription.
 * - premium_added: Premium became entitled on a subscription (webhook or confirmed add).
 * - premium_removed: Premium was scheduled for removal, or left the subscription.
 * - premium_fallback_to_standard: a call on an account with the add-on was minted on Standard.
 * - voice_cap_hit {subject: "user", subjectId, reason}: the voice allowance is used up (server side, ids only, never
 *   awaited in the request path). reason "cap_reached": a voice start was refused with the 402 at a mint route
 *   (/api/realtime/session or /api/elevenlabs/token). reason "cap_reached_in_call": POST /api/usage/heartbeat stopped
 *   a running call because its plan cap was reached, once per call. Free calls are not stopped by the cap once started
 *   (only by the call length limit), so they emit only at the start.
 */

export type PremiumEventName = "premium_upsell_viewed" | "premium_add_started" | "premium_added" | "premium_removed" | "premium_fallback_to_standard" | "voice_cap_hit";

export type UpsellSurface = "setup" | "billing" | "checkout" | "pricing" | "live";

export interface PremiumEvent {
  name: PremiumEventName;
  /** premium_upsell_viewed only. */
  surface?: UpsellSurface;
  subject?: "user" | "organization";
  subjectId?: string;
  plan?: "pro" | "team";
  units?: number;
  /**
   * premium_removed: scheduled (period end) or ended (left the subscription). premium_fallback_to_standard: minutes_used or
   * not_entitled. voice_cap_hit: cap_reached (refused at mint) or cap_reached_in_call (stopped by the heartbeat).
   */
  reason?: string;
}

/** Browser event name for the client seam. A deployment can listen with window.addEventListener(PREMIUM_DOM_EVENT, ...). */
export const PREMIUM_DOM_EVENT = "calltrainer:premium-event";

/**
 * Browser seam for premium_upsell_viewed. Dispatches a DOM CustomEvent once per surface per page view, and nothing
 * else: no network call, no storage, no third-party script.
 */
const seen = new Set<string>();
export function trackPremiumUpsell(surface: UpsellSurface, target: { dispatchEvent(e: Event): boolean } | null = typeof window === "undefined" ? null : window): boolean {
  if (!target || seen.has(surface) || typeof CustomEvent === "undefined") return false;
  seen.add(surface);
  const detail: PremiumEvent = { name: "premium_upsell_viewed", surface };
  target.dispatchEvent(new CustomEvent(PREMIUM_DOM_EVENT, { detail }));
  return true;
}

/** Test hook: forget which surfaces were already reported. */
export const resetPremiumUpsellSeen = (): void => seen.clear();

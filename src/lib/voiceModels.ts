import "server-only";
import type { VoiceTier } from "./voiceTier";

/**
 * Voice tier to OpenAI Realtime model id. Server-only so the ids never ship to the browser; the UI
 * shows only "Standard" and "Premium" (src/lib/voiceTier.ts).
 *
 * Model ids (checked 2026-11-05):
 * - Standard: https://platform.openai.com/docs/models/gpt-realtime-2.1-mini
 * - Premium:  https://platform.openai.com/docs/models/gpt-realtime-2.1
 * - Pricing:  https://platform.openai.com/docs/pricing
 */

export const STANDARD_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const PREMIUM_REALTIME_MODEL = "gpt-realtime-2.1";

type Env = Record<string, string | undefined>;

/**
 * Model id for a tier. Standard reads REALTIME_MODEL_STANDARD, then the existing REALTIME_MODEL
 * (so a deployment that already sets it keeps exactly the model it runs today), then the default.
 * Premium reads REALTIME_MODEL_PREMIUM, then the default.
 */
export function resolveTierModel(tier: VoiceTier, env: Env): string {
  const v = (s: string | undefined) => s?.trim() || undefined;
  if (tier === "premium") return v(env.REALTIME_MODEL_PREMIUM) ?? PREMIUM_REALTIME_MODEL;
  return v(env.REALTIME_MODEL_STANDARD) ?? v(env.REALTIME_MODEL) ?? STANDARD_REALTIME_MODEL;
}

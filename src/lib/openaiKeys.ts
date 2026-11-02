import "server-only";
import { prisma } from "./db";
import { decryptByok } from "./byok";
import { resolveRealtimeKey } from "./realtime";
import { DEMO_USER, billingActive, isOpenAiBaseUrl, openAiTierKeys, resolveLlmKey } from "./serverConfig";
import { currentPlan } from "./usagePlan";

/**
 * OpenAI key routing by plan (STR-690). Every server call to OpenAI, and to the configured LLM, takes its key from
 * openAiKeyFor: the client never picks a key or a project.
 *
 * Projects: free and unauthenticated or demo traffic runs on `calltrainer-free` (OPENAI_API_KEY_FREE), Pro and Team
 * on `calltrainer-paid` (OPENAI_API_KEY_PAID), and a Team with its own stored key on that key ("byok"). Each project
 * has its own hard spend limit and rate limits in the OpenAI dashboard, so spend shows separately per project.
 *
 * Fallback rule, per tier:
 *   1. a Team's own key (BYOK), when the team is on Team and the key decrypts;
 *   2. the tier's own key (OPENAI_API_KEY_FREE or OPENAI_API_KEY_PAID);
 *   3. the shared single key (OPENAI_REALTIME_API_KEY / OPENAI_API_KEY / LLM_API_KEY as before), so a single-key
 *      install keeps working, except that Free never gets the shared key when it is the same value as the paid key;
 *   4. nothing: voice answers with the existing 503 realtime_not_configured, and the coach, grader, wizard and
 *      text caller use their rules-based fallbacks.
 * A tier's own key is never used for the other tier: Free never gets the paid key, and Paid never spends on the free
 * project. With a custom LLM_BASE_URL the LLM jobs keep using LLM_API_KEY ("custom"); an OpenAI key, tier or BYOK, is
 * never sent to a third-party base URL.
 */

export type OpenAiProject = "free" | "paid" | "byok" | "custom";
export type KeyKind = "realtime" | "llm";
export type Tier = "free" | "paid";

export interface KeyRoute {
  /** The bearer token. Server-only: never log it, return it or put it in an error. */
  key: string;
  project: OpenAiProject;
  /** True when the key is the shared single key rather than the tier's own (spend is not separated). */
  shared: boolean;
}

export interface PlanContext {
  tier: Tier;
  /** The Team's own decrypted key, only for a team currently on the Team plan. */
  byokKey?: string;
}

type Env = Record<string, string | undefined>;

const FREE: PlanContext = { tier: "free" };

/** The key for a plan and job. Pure: the env is the only input besides the plan. */
export function pickKey(ctx: PlanContext, kind: KeyKind, env: Env = process.env): KeyRoute | null {
  if (kind === "llm" && !isOpenAiBaseUrl(env.LLM_BASE_URL || "https://api.openai.com/v1")) {
    const own = env.LLM_API_KEY?.trim();
    return own ? { key: own, project: "custom", shared: true } : null;
  }
  if (ctx.byokKey) return { key: ctx.byokKey, project: "byok", shared: false };
  const tiers = openAiTierKeys(env);
  const own = ctx.tier === "paid" ? tiers.paid : tiers.free;
  if (own) return { key: own, project: ctx.tier, shared: false };
  const legacy = kind === "realtime" ? resolveRealtimeKey(env) : resolveLlmKey(env);
  if (!legacy) return null;
  // Free must never spend on the paid project, even when an operator pasted the paid key into OPENAI_API_KEY as well.
  if (ctx.tier === "free" && tiers.paid && legacy === tiers.paid) return null;
  return { key: legacy, project: ctx.tier, shared: true };
}

/** True when some plan could get a key for this job, so a route can skip its per-user lookup when none can. */
export function anyKeyFor(kind: KeyKind, env: Env = process.env): boolean {
  return Boolean(pickKey(FREE, kind, env) || pickKey({ tier: "paid" }, kind, env));
}

/**
 * The plan context for a user, from the same plan rule metering uses (currentPlan in usagePlan.ts): Pro, or a Team
 * organization, while billing is on and Stripe's subscription state left them on it (active, trialing and past_due
 * keep the plan; see ENTITLED in billing.ts). Demo, database-less and unknown users are Free. A failed lookup is Free
 * too, so an outage can only move traffic to the free project, never the other way.
 */
export async function planContextFor(userId: string | null | undefined, env: Env = process.env): Promise<PlanContext> {
  if (!userId || userId === DEMO_USER.id || env.DEMO_MODE === "true" || !env.DATABASE_URL) return FREE;
  let user: { planTier: string; organization: { id: string; planTier: string; openaiKeyCiphertext: string | null } | null } | null;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: { planTier: true, organization: { select: { id: true, planTier: true, openaiKeyCiphertext: true } } },
    });
  } catch (e) {
    console.error("[openaiKeys] plan lookup failed, using the free project", e instanceof Error ? e.name : "unknown");
    return FREE;
  }
  if (!user) return FREE;
  const org = user.organization;
  const { plan, pooled } = currentPlan(user, org, billingActive(env));
  if (plan === "free") return FREE;
  if (pooled && org?.openaiKeyCiphertext) {
    try {
      return { tier: "paid", byokKey: decryptByok(org.openaiKeyCiphertext, org.id) };
    } catch (e) {
      // The team is still a paying customer, so it runs on the paid project. Never log the blob or the key.
      console.error("[openaiKeys] team key could not be decrypted, using the paid project", e instanceof Error ? e.message : "unknown");
    }
  }
  return { tier: "paid" };
}

/** The key, and the project it bills, for this user's OpenAI call. Null means no key is available for their plan. */
export async function openAiKeyFor(userId: string | null | undefined, kind: KeyKind, env: Env = process.env): Promise<KeyRoute | null> {
  if (!anyKeyFor(kind, env)) return null;
  return pickKey(await planContextFor(userId, env), kind, env);
}

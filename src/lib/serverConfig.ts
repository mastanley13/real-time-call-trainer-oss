import "server-only";
import { safeEqual } from "./access";
import { OPENAI_DEFAULT_BASE_URL, isOpenAiBaseUrl } from "./openaiHost";
import { chatKeyPlan, voiceKeyPlan } from "./openaiKeys";
import { orderVoiceEngines } from "./realtime";
import { stripeReady, stripeStatus } from "./stripe";
import { isPremiumOnSale } from "./pricing";
import { isTrialSampleOn } from "./premiumTrial";

/**
 * Voice minutes are metered for stored accounts (not demo mode, with a database) when USAGE_CAPS=on or Stripe is
 * configured. Default off, so a self-hosted install stays uncapped. With USAGE_CAPS=on and no Stripe key everyone
 * is on Free (10 minutes a month) and voice fails closed on a lookup error; paid plans only come from Stripe
 * subscription state. A Stripe key that is set but refused (a live key) still meters, so a misconfigured paid
 * deployment fails closed instead of open. Text practice is never metered.
 */
export function meteringEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE !== "true" && Boolean(env.DATABASE_URL) && (env.USAGE_CAPS?.trim() === "on" || stripeStatus(env) !== "disabled");
}

/** True when plans can be paid for: Stripe is configured (a refused live key still counts, so it fails closed). */
export const billingActive = (env: Record<string, string | undefined> = process.env): boolean => stripeStatus(env) !== "disabled";

/**
 * True when the pricing buttons may offer a paid start: the same check /api/config reports as `billing`. A Stripe
 * test key counts, and a live key counts only with STRIPE_LIVE_MODE=true (stripeReady). A refused or mismatched key, a
 * missing one, or demo mode reads as off and the buttons show the billing-off state.
 */
export const billingOn = (env: Record<string, string | undefined> = process.env): boolean => stripeReady(env);

/**
 * Premium Voice is on sale: PREMIUM_VOICE_ON_SALE is exactly "true" AND billing is on. Default off. Gates purchases
 * (checkout premium:true, add to an existing subscription, the buy controls), the add-on quantity sync, and paid
 * Premium at mint (usage.ts ensureAllowance). Never comped Premium, and never removal.
 */
export const premiumOnSale = (env: Record<string, string | undefined> = process.env): boolean => isPremiumOnSale(env) && billingOn(env);

/**
 * The Free organization Premium trial call is offered: PREMIUM_TRIAL_SAMPLE_ON is exactly "true" and not demo mode.
 * Default off. Independent of PREMIUM_VOICE_ON_SALE and of billing (a USAGE_CAPS=on install without Stripe is all Free
 * and may offer it). Read at every mint (usage.ts beginCall); see src/lib/premiumTrial.ts for who is eligible.
 */
export const premiumTrialSampleOn = (env: Record<string, string | undefined> = process.env): boolean => isTrialSampleOn(env) && env.DEMO_MODE !== "true";

type Env = Record<string, string | undefined>;

/*
 * The OpenAI Realtime model for a session is picked by the organization's voice tier in /api/realtime/session
 * (orgVoiceTierForUser in src/lib/voiceTierServer.ts, resolveTierModel in src/lib/voiceModels.ts), not by the
 * metered engine. The engine still drives minute caps and billing (src/lib/usage.ts) and the ElevenLabs agent below.
 */

/**
 * The ElevenLabs agent for a session. Premium is ELEVENLABS_AGENT_ID. Standard is
 * ELEVENLABS_AGENT_ID_STANDARD; when that is unset there is nothing to switch to, so `standardAvailable`
 * is false and the call runs on the main agent and counts as premium.
 */
export function elevenLabsAgentFor(engine: "premium" | "standard", env: Env = process.env): { agentId: string | undefined; standardAvailable: boolean } {
  const main = env.ELEVENLABS_AGENT_ID?.trim() || undefined;
  const standard = env.ELEVENLABS_AGENT_ID_STANDARD?.trim() || undefined;
  return { agentId: engine === "standard" && standard ? standard : main, standardAvailable: Boolean(standard) };
}

/**
 * Runtime capability flags. Everything is optional; the UI degrades gracefully. /api/config returns this object
 * unauthenticated, so it carries booleans and provider names only. Model ids (LLM_MODEL, LLM_MODEL_GRADING and the
 * REALTIME_MODEL variables) stay on the server: read them with llmModel(), llmGradingModel() and voiceModelFor()
 * (src/lib/voiceTierServer.ts) where a provider request needs them.
 */
export function getCapabilities() {
  const elevenlabs = Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);
  // OPENAI_REALTIME_API_KEY, else any OpenAI key slot, else LLM_API_KEY on an OpenAI base (voiceKeyPlan in openaiKeys.ts).
  const realtime = voiceKeyPlan(process.env).kind !== "none";
  return {
    /** Fails closed: false whenever the production guard blocks demo mode, so requireAuth never yields DEMO_USER. */
    demoMode: process.env.DEMO_MODE === "true" && !productionGuard(process.env).problems.includes("demo_in_production"),
    elevenlabs,
    /** OpenAI Realtime voice (WebRTC). On whenever an OpenAI key is available. */
    realtime,
    /** Voice engines in preference order: OpenAI first unless VOICE_ENGINE=elevenlabs. Empty means text only. */
    voiceEngines: orderVoiceEngines({ openai: realtime, elevenlabs }, process.env.VOICE_ENGINE),
    llm: Boolean(llmKey()),
    database: Boolean(process.env.DATABASE_URL),
    /** Stripe test-mode billing: false when unset, in demo mode, or when the key is not an sk_test_ key. */
    billing: billingOn(),
    /** Hosted build: Stripe is configured (billingActive). The header hides the AI status chip from non-admins. */
    hosted: billingActive(),
    /** Premium Voice is on sale (PREMIUM_VOICE_ON_SALE=true with billing on). False hides every Premium buy control. */
    premiumOnSale: premiumOnSale(),
    /** "openai" when LLM_BASE_URL is unset or points at api.openai.com; the URL itself is never exposed. */
    provider: isOpenAiBaseUrl(llmBaseUrl()) ? ("openai" as const) : ("custom" as const),
  };
}

/**
 * LLM_API_KEY, else the first OpenAI key slot (OPENAI_API_KEY, then OPENAI_API_KEY_BACKUP_1 and _2) only while
 * LLM_BASE_URL points at OpenAI (exact host, isOpenAiBaseUrl in openaiHost.ts). An OpenAI key set for voice must
 * never go out as the bearer token to a third-party base URL. This answers "is chat configured"; each request picks
 * its key through chatKeyPlan and withOpenAiKeyFailover in openaiKeys.ts.
 */
export function resolveLlmKey(env: Env): string | undefined {
  const plan = chatKeyPlan(env);
  if (plan.kind === "single") return plan.key;
  if (plan.kind === "ladder") return plan.slots[0].key;
  return undefined;
}

/**
 * Production guard. DEMO_MODE disables authentication, so it must not reach a production
 * deployment by accident. `ALLOW_PUBLIC_DEMO=true` is the explicit opt-in for a public demo.
 * `demo_in_production` blocks boot; `database_missing` only makes /api/health unhealthy.
 */
export type ProductionGuardProblem = "demo_in_production" | "database_missing";

export function productionGuard(env: Env): { ok: boolean; problems: ProductionGuardProblem[] } {
  const problems: ProductionGuardProblem[] = [];
  if (env.NODE_ENV === "production") {
    const demo = env.DEMO_MODE === "true";
    if (demo && env.ALLOW_PUBLIC_DEMO !== "true") problems.push("demo_in_production");
    if (!demo && !env.DATABASE_URL?.trim()) problems.push("database_missing");
  }
  return { ok: problems.length === 0, problems };
}

/** Throws when the environment must not boot. Called from `register()` in src/instrumentation.ts. */
export function assertBootAllowed(env: Env = process.env): void {
  if (productionGuard(env).problems.includes("demo_in_production")) {
    throw new Error(
      "DEMO_MODE=true is not allowed when NODE_ENV=production because it disables authentication. Unset DEMO_MODE, or set ALLOW_PUBLIC_DEMO=true to run a public demo on purpose.",
    );
  }
}

export function llmKey(): string | undefined {
  return resolveLlmKey(process.env);
}

/**
 * Cron auth: only "Authorization: Bearer ${CRON_SECRET}", compared in constant time. Vercel Cron
 * sends that header itself when CRON_SECRET is set. The x-vercel-cron header is client-controlled
 * and is never trusted.
 */
export function cronAuthorized(authorization: string | null | undefined, secret: string | undefined): boolean {
  const want = secret?.trim();
  if (!want) return false;
  const auth = authorization ?? "";
  if (!/^bearer /i.test(auth)) return false;
  return safeEqual(auth.slice(7).trim(), want);
}

/** The built-in chat model when LLM_MODEL is unset. */
const DEFAULT_CHAT_MODEL = "gpt-6-luna";

/** Live coach, text simulation and other per-turn chat. Default gpt-6-luna. */
export function llmModel(): string {
  return process.env.LLM_MODEL || DEFAULT_CHAT_MODEL;
}

/** Final grading and scoring. LLM_MODEL_GRADING, or LLM_MODEL when that is unset. */
export function llmGradingModel(): string {
  return process.env.LLM_MODEL_GRADING || llmModel();
}

/** Secondary AI model for grading fallback when LLM_MODEL_GRADING differs from LLM_MODEL, else undefined. */
export function llmGradingFallbackModel(): string | undefined {
  const primary = llmGradingModel();
  const secondary = llmModel();
  return secondary !== primary ? secondary : undefined;
}

/** Reasoning effort for final call grading on OpenAI reasoning models. Env-tunable via LLM_GRADING_REASONING. */
export function llmGradingReasoningEffort(): "minimal" | "low" | "medium" | "high" {
  const raw = process.env.LLM_GRADING_REASONING?.trim().toLowerCase();
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
}

/*
 * Persona wizard builder. Server-only: none of this is in getCapabilities(), so /api/config stays booleans and
 * provider names only, and no key or model id reaches the browser.
 *
 * - WIZARD_PROVIDER: "anthropic" or "openai" (any case). Unset picks Anthropic when an Anthropic key is present.
 * - WIZARD_API_KEY: a dedicated wizard key. It counts as an Anthropic key when WIZARD_PROVIDER=anthropic, or when the
 *   provider is unset and the key starts with sk-ant-. Otherwise it is an OpenAI key, sent only to api.openai.com.
 * - ANTHROPIC_API_KEY: the Anthropic key when WIZARD_API_KEY is not one.
 * - WIZARD_MODEL: overrides the builder model for whichever provider runs it.
 */
export type WizardProvider = "anthropic" | "openai" | "none";

/** Default builder model on the Anthropic Messages API. */
const DEFAULT_WIZARD_ANTHROPIC_MODEL = "claude-opus-5-5";
/** Default builder model on OpenAI (never falls back to the lighter per-turn chat model on api.openai.com). */
const DEFAULT_WIZARD_OPENAI_MODEL = "gpt-6-astra";

const wizardProviderSetting = (env: Env) => env.WIZARD_PROVIDER?.trim().toLowerCase() || undefined;

/** The Anthropic key for the wizard, or undefined. Only ever sent to api.anthropic.com (src/lib/wizardLlm.ts). */
export function anthropicKey(env: Env = process.env): string | undefined {
  const setting = wizardProviderSetting(env);
  const wizardKey = env.WIZARD_API_KEY?.trim();
  if (wizardKey && (setting === "anthropic" || (!setting && wizardKey.startsWith("sk-ant-")))) return wizardKey;
  if (setting === "openai") return undefined;
  return env.ANTHROPIC_API_KEY?.trim() || undefined;
}

/**
 * A dedicated OpenAI key for the wizard: WIZARD_API_KEY when it is not the Anthropic key. Never an sk-ant- key, so an
 * Anthropic key can't go to OpenAI even when WIZARD_PROVIDER=openai is set by mistake.
 */
export function wizardOpenAiKey(env: Env = process.env): string | undefined {
  const wizardKey = env.WIZARD_API_KEY?.trim();
  if (!wizardKey || wizardKey === anthropicKey(env) || wizardKey.startsWith("sk-ant-")) return undefined;
  return wizardKey;
}

/**
 * Which provider builds wizard personas. WIZARD_PROVIDER=openai forces OpenAI (or the custom LLM base) when a key for
 * it exists. Otherwise an Anthropic key wins, then a dedicated WIZARD_API_KEY or the chat key. "none" means the
 * template draft.
 */
export function wizardProvider(env: Env = process.env): WizardProvider {
  const openAiReady = Boolean(wizardOpenAiKey(env) || resolveLlmKey(env));
  if (wizardProviderSetting(env) === "openai") return openAiReady ? "openai" : "none";
  if (anthropicKey(env)) return "anthropic";
  return openAiReady ? "openai" : "none";
}

/**
 * The wizard model on the OpenAI/chat provider: on OpenAI's host it defaults to gpt-6-astra (never gpt-6-luna)
 * so persona generation always runs on a high-intelligence builder. Custom non-OpenAI hosts keep LLM_MODEL_GRADING / LLM_MODEL.
 */
export function wizardFallbackModel(env: Env = process.env): string {
  const base = (env.LLM_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
  if (wizardOpenAiKey(env) || isOpenAiBaseUrl(base)) return DEFAULT_WIZARD_OPENAI_MODEL;
  return env.LLM_MODEL_GRADING || env.LLM_MODEL || DEFAULT_WIZARD_OPENAI_MODEL;
}

/**
 * The builder model: WIZARD_MODEL, else the Anthropic default (claude-opus-5-5) on the Anthropic path,
 * else the OpenAI default (gpt-6-astra) on OpenAI's host. Server-only; never returned to the browser.
 */
export function wizardModel(env: Env = process.env): string {
  const set = env.WIZARD_MODEL?.trim();
  if (set) return set;
  if (wizardProvider(env) === "anthropic") return DEFAULT_WIZARD_ANTHROPIC_MODEL;
  return wizardFallbackModel(env);
}

export function llmBaseUrl(): string {
  return (process.env.LLM_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** Optional model override for OpenAI web-search website research in the Persona Wizard. Defaults to llmModel(). */
export function webResearchModel(env: Env = process.env): string {
  return env.WEB_RESEARCH_MODEL?.trim() || llmModel();
}

/** Optional Firecrawl API key for headless JS page rendering in /api/persona/fetch-url. */
export function firecrawlKey(env: Env = process.env): string | undefined {
  return env.FIRECRAWL_API_KEY?.trim() || undefined;
}

export const DEMO_USER = {
  id: "demo-user",
  email: "demo@example.local",
  firstName: "Demo",
  lastName: "User",
  role: "owner" as const,
};

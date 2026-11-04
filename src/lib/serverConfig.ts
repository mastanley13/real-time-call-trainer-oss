import "server-only";
import { safeEqual } from "./access";
import { orderVoiceEngines, realtimeKey, realtimeModel } from "./realtime";
import { stripeReady, stripeStatus } from "./stripe";

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

type Env = Record<string, string | undefined>;

export const DEFAULT_STANDARD_REALTIME_MODEL = "gpt-realtime-mini";

/**
 * The Realtime model for a session. Premium is the configured REALTIME_MODEL; standard is
 * REALTIME_MODEL_STANDARD (default gpt-realtime-mini). Without metering there is no entitlement to
 * check, so the configured model runs as before.
 */
export function realtimeModelFor(engine: "premium" | "standard", env: Env = process.env): string {
  if (engine === "premium") return realtimeModel();
  return env.REALTIME_MODEL_STANDARD?.trim() || DEFAULT_STANDARD_REALTIME_MODEL;
}

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

/** Runtime capability flags. Everything is optional; the UI degrades gracefully. */
export function getCapabilities() {
  const elevenlabs = Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);
  const realtime = Boolean(realtimeKey());
  return {
    /** Fails closed: false whenever the production guard blocks demo mode, so requireAuth never yields DEMO_USER. */
    demoMode: process.env.DEMO_MODE === "true" && !productionGuard(process.env).problems.includes("demo_in_production"),
    elevenlabs,
    /** OpenAI Realtime voice (WebRTC). On whenever an OpenAI key is available. */
    realtime,
    /** Voice engines in preference order: OpenAI first unless VOICE_ENGINE=elevenlabs. Empty means text only. */
    voiceEngines: orderVoiceEngines({ openai: realtime, elevenlabs }, process.env.VOICE_ENGINE),
    ...(realtime ? { realtimeModel: realtimeModel() } : {}),
    llm: Boolean(llmKey()),
    database: Boolean(process.env.DATABASE_URL),
    /** Stripe test-mode billing: false when unset, in demo mode, or when the key is not an sk_test_ key. */
    billing: billingOn(),
    /** Model used for the coach, grading, persona wizard and text caller. Shown in provenance chips. */
    model: llmModel(),
    /** "openai" when LLM_BASE_URL is unset or points at api.openai.com; the URL itself is never exposed. */
    provider: isOpenAiBaseUrl(llmBaseUrl()) ? ("openai" as const) : ("custom" as const),
  };
}

/** Exact host match: \b alone would also accept api.openai.com.attacker.example. */
const isOpenAiBaseUrl = (url: string) => /^https:\/\/api\.openai\.com(?::443)?(?:\/|$)/i.test(url.trim());

/**
 * LLM_API_KEY, else OPENAI_API_KEY only while LLM_BASE_URL points at OpenAI. An OpenAI key
 * set for voice must never go out as the bearer token to a third-party base URL.
 */
export function resolveLlmKey(env: Env): string | undefined {
  const own = env.LLM_API_KEY?.trim();
  if (own) return own;
  return isOpenAiBaseUrl(env.LLM_BASE_URL || "https://api.openai.com/v1") ? env.OPENAI_API_KEY?.trim() || undefined : undefined;
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

export function llmModel(): string {
  return process.env.LLM_MODEL || "gpt-4.1-mini";
}

export function llmBaseUrl(): string {
  return (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

export const DEMO_USER = {
  id: "demo-user",
  email: "demo@example.local",
  firstName: "Demo",
  lastName: "User",
  role: "owner" as const,
};

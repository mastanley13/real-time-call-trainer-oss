import "server-only";
import { safeEqual } from "./access";
import { DEFAULT_REALTIME_MODEL, orderVoiceEngines, realtimeKey } from "./realtime";
import { pickVoiceModel } from "./voiceModel";
import { stripeStatus } from "./stripe";

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

type Env = Record<string, string | undefined>;

export const DEFAULT_STANDARD_REALTIME_MODEL = "gpt-realtime-2.1-mini";

/**
 * The only function that names a voice model. Premium is REALTIME_MODEL (default gpt-realtime-2.1); standard is
 * REALTIME_MODEL_STANDARD (default gpt-realtime-2.1-mini). A deployment can override both; /settings/models
 * shows what is live.
 */
export function realtimeModelFor(engine: "premium" | "standard", env: Env = process.env): string {
  if (engine === "premium") return env.REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  return env.REALTIME_MODEL_STANDARD?.trim() || DEFAULT_STANDARD_REALTIME_MODEL;
}

/**
 * The model a session runs on. Without metering there is no entitlement to check, so the engine is unknown
 * and the call runs premium, exactly as the session route does.
 */
export function voiceModelForCall(engine: "premium" | "standard" | undefined, env: Env = process.env): string {
  return pickVoiceModel({ premium: realtimeModelFor("premium", env), standard: realtimeModelFor("standard", env) }, engine);
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
    ...(realtime ? { realtimeModel: realtimeModelFor("premium"), realtimeModelStandard: realtimeModelFor("standard") } : {}),
    /** True when at least one text role has a key. */
    llm: LLM_ROLES.some((r) => Boolean(llmKeyFor(r))),
    /** Model per text role, for the roles that have a key. A role without a key runs its rules-based fallback. */
    llmModels: Object.fromEntries(LLM_ROLES.filter((r) => llmKeyFor(r)).map((r) => [r, llmModelFor(r)])) as Partial<Record<LlmRole, string>>,
    database: Boolean(process.env.DATABASE_URL),
    /** Stripe test-mode billing: false when unset, in demo mode, or when the key is not an sk_test_ key. */
    billing: stripeStatus() === "ready",
    /** The deployment's general text model (LLM_MODEL). Per-role models are in llmModels. */
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

/** Code default for every text role. Cheap and fast: the coach and the text caller run on it every turn. */
export const DEFAULT_LLM_MODEL = "gpt-6-luna";

/** The AI jobs that run on a chat model. Each can have its own model, base URL and key. */
export const LLM_ROLES = ["coach", "grade", "persona", "wizard"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

/**
 * LLM_MODEL_<ROLE>, else LLM_MODEL, else the code default. The grader has no default of its own:
 * it follows the deployment's LLM_MODEL until LLM_MODEL_GRADE is set on purpose.
 */
export function llmModelFor(role: LlmRole, env: Env = process.env): string {
  return env[`LLM_MODEL_${role.toUpperCase()}`]?.trim() || env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
}

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/** LLM_BASE_URL_<ROLE>, else LLM_BASE_URL, else OpenAI. */
export function llmBaseUrlFor(role: LlmRole, env: Env = process.env): string {
  return (env[`LLM_BASE_URL_${role.toUpperCase()}`]?.trim() || env.LLM_BASE_URL?.trim() || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * LLM_API_KEY_<ROLE>, else LLM_API_KEY, else OPENAI_API_KEY while the role's base URL is OpenAI.
 * The shared LLM_API_KEY belongs to the shared LLM_BASE_URL: a role that points at a different base URL without
 * its own key does not get it, so moving one role to another provider can never send the first provider's key there.
 */
export function resolveLlmKeyFor(role: LlmRole, env: Env = process.env): string | undefined {
  const own = env[`LLM_API_KEY_${role.toUpperCase()}`]?.trim();
  if (own) return own;
  const base = llmBaseUrlFor(role, env);
  const sharedBase = (env.LLM_BASE_URL?.trim() || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
  const shared = env.LLM_API_KEY?.trim();
  if (shared && base === sharedBase) return shared;
  return isOpenAiBaseUrl(base) ? env.OPENAI_API_KEY?.trim() || undefined : undefined;
}

export const llmKeyFor = (role: LlmRole): string | undefined => resolveLlmKeyFor(role, process.env);

/** The general, role-less model: LLM_MODEL or the code default. Roles use llmModelFor. */
export function llmModel(): string {
  return process.env.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
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

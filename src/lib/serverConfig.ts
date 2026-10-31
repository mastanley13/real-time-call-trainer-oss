import "server-only";
import { safeEqual } from "./access";
import { orderVoiceEngines, realtimeKey, realtimeModel } from "./realtime";
import { stripeStatus } from "./stripe";

/** Voice minutes are metered only for stored accounts: not in demo mode and not without a database. */
export function meteringEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE !== "true" && Boolean(env.DATABASE_URL);
}

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
    demoMode: process.env.DEMO_MODE === "true",
    elevenlabs,
    /** OpenAI Realtime voice (WebRTC). On whenever an OpenAI key is available. */
    realtime,
    /** Voice engines in preference order: OpenAI first unless VOICE_ENGINE=elevenlabs. Empty means text only. */
    voiceEngines: orderVoiceEngines({ openai: realtime, elevenlabs }, process.env.VOICE_ENGINE),
    ...(realtime ? { realtimeModel: realtimeModel() } : {}),
    llm: Boolean(llmKey()),
    database: Boolean(process.env.DATABASE_URL),
    /** Stripe test-mode billing: false when unset, in demo mode, or when the key is not an sk_test_ key. */
    billing: stripeStatus() === "ready",
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

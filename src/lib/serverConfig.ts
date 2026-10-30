import "server-only";
import { safeEqual } from "./access";
import { orderVoiceEngines, realtimeKey, realtimeModel } from "./realtime";
import { googleEnabled } from "./googleAuth";

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
    /** "Continue with Google" is offered (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set, and not demo mode). */
    google: googleEnabled() && Boolean(process.env.DATABASE_URL),
    /** Model used for the coach, grading, persona wizard and text caller. Shown in provenance chips. */
    model: llmModel(),
    /** "openai" when LLM_BASE_URL is unset or points at api.openai.com; the URL itself is never exposed. */
    provider: isOpenAiBaseUrl(llmBaseUrl()) ? ("openai" as const) : ("custom" as const),
  };
}

/** Exact host match: \b alone would also accept api.openai.com.attacker.example. */
const isOpenAiBaseUrl = (url: string) => /^https:\/\/api\.openai\.com(?::443)?(?:\/|$)/i.test(url.trim());

type Env = Record<string, string | undefined>;

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

import "server-only";
import { llmKey } from "./serverConfig";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal OpenAI-compatible chat completion call (works with OpenAI, Azure,
 * OpenRouter, Ollama, vLLM...). Configure with LLM_API_KEY (or OPENAI_API_KEY),
 * LLM_BASE_URL and LLM_MODEL. Used only for post-call grading and the text
 * simulation; voice is handled by ElevenLabs.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = llmKey();
  if (!key) throw new Error("LLM_NOT_CONFIGURED");
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1800,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("LLM_BAD_RESPONSE");
  return text;
}

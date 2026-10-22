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
  // Anthropic's OpenAI-compatible endpoint ignores response_format, so we
  // never send it there and rely on extractJson() + the prompt instead.
  const sendJsonFormat = opts.json && !/anthropic\.com/i.test(base);
  const call = (withTemperature: boolean) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "gpt-4.1-mini",
        messages,
        ...(withTemperature ? { temperature: opts.temperature ?? 0.4 } : {}),
        max_tokens: opts.maxTokens ?? 1800,
        ...(sendJsonFormat ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  let res = await call(true);
  let detail = "";
  if (!res.ok) {
    detail = (await res.text().catch(() => "")).slice(0, 300);
    // Some newer models reject `temperature`; retry once without it.
    if (res.status === 400 && /temperature/i.test(detail)) {
      res = await call(false);
      detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    }
  }
  if (!res.ok) {
    // Include the provider's error text (never the key) so misconfiguration is diagnosable from logs.
    throw new Error(`LLM_HTTP_${res.status} ${base}/chat/completions ${detail}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? "").join("") : raw;
  if (typeof text !== "string") throw new Error("LLM_BAD_RESPONSE");
  return text;
}

/** Parse a JSON object from model text that may be fenced or surrounded by prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error("LLM_BAD_JSON");
}

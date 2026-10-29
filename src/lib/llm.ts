import "server-only";
import { llmBaseUrl, llmKey, llmModel } from "./serverConfig";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal OpenAI-compatible chat completion call (works with OpenAI, Azure,
 * OpenRouter, Ollama, vLLM...). Configure with LLM_API_KEY (or OPENAI_API_KEY),
 * LLM_BASE_URL and LLM_MODEL. Used for the coach, grading, the persona wizard
 * and the text simulation; voice goes through OpenAI Realtime or ElevenLabs.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  return (await chatFull(messages, opts)).text;
}

/** Like chat(), but also reports whether the model stopped because it hit max_tokens. */
export async function chatFull(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<{ text: string; truncated: boolean }> {
  const key = llmKey();
  if (!key) throw new Error("LLM_NOT_CONFIGURED");
  const base = llmBaseUrl();
  // Anthropic's OpenAI-compatible endpoint ignores response_format, so we
  // never send it there and rely on extractJson() + the prompt instead.
  const sendJsonFormat = opts.json && !/anthropic\.com/i.test(base);
  const call = (withTemperature: boolean) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llmModel(),
        messages,
        ...(withTemperature ? { temperature: opts.temperature ?? 0.4 } : {}),
        max_tokens: opts.maxTokens ?? 1800,
        ...(sendJsonFormat ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  let res = await call(true);
  if (!res.ok && res.status === 400) {
    // Some newer models reject `temperature`; retry once without it. The body is only inspected, never logged.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    if (/temperature/i.test(detail)) res = await call(false);
  }
  if (!res.ok) {
    // Status only: provider error bodies can echo prompts or account details, and callers log this message.
    throw new Error(`LLM_HTTP_${res.status}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? "").join("") : raw;
  if (typeof text !== "string") throw new Error("LLM_BAD_RESPONSE");
  const reason = data?.choices?.[0]?.finish_reason ?? data?.stop_reason;
  return { text, truncated: reason === "length" || reason === "max_tokens" };
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

import "server-only";
import {
  MAX_ERROR_BODY_BYTES,
  OPENAI_QUOTA_ERROR_CODES,
  chatKeyPlan,
  classifyOpenAiFailure,
  classifyOpenAiResponseDetail,
  readBoundedBody,
  withOpenAiKeyFailover,
} from "./openaiKeys";
import { llmOutcomeFromStatus, recordLlmOutcome, refineLlmOutcome, type LlmOutcome } from "./llmStatus";
import { llmBaseUrl, llmModel } from "./serverConfig";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal OpenAI-compatible chat completion call (works with OpenAI, Azure,
 * OpenRouter, Ollama, vLLM...). Configure with LLM_API_KEY (or OPENAI_API_KEY and its
 * OPENAI_API_KEY_BACKUP_* failover keys, OpenAI base only), LLM_BASE_URL and LLM_MODEL.
 * Used for the coach, grading, the persona wizard and the text simulation; voice goes
 * through OpenAI Realtime or ElevenLabs. Throws LLM_QUOTA_EXHAUSTED when every OpenAI
 * key slot is out of quota; callers already fall back on any error.
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
  // Per request: an explicit LLM_API_KEY (or no OpenAI base) never uses the OpenAI key ladder.
  const plan = chatKeyPlan(process.env);
  if (plan.kind === "none") throw new Error("LLM_NOT_CONFIGURED");
  const base = llmBaseUrl();
  const url = `${base}/chat/completions`;
  // Anthropic's OpenAI-compatible endpoint ignores response_format, so we
  // never send it there and rely on extractJson() + the prompt instead.
  const sendJsonFormat = opts.json && !/anthropic\.com/i.test(base);
  /** One request on one key, with the existing same-key retry without temperature. `pinned` refuses redirects. */
  const send = async (key: string, pinned: boolean) => {
    const call = (withTemperature: boolean) =>
      fetch(url, {
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
        ...(pinned ? { redirect: "error" as const } : {}),
      });
    let res = await call(true);
    let detail: string | undefined;
    if (!res.ok && res.status === 400) {
      // Some newer models reject `temperature`; retry once without it. The body is only inspected (bounded), never logged.
      detail = await readBoundedBody(res);
      if (/temperature/i.test(detail.slice(0, 300))) {
        res = await call(false);
        detail = undefined;
      }
    }
    return { res, detail };
  };

  type Sent = { res: Response; detail?: string };
  /** Set only when an attempt in this call actually got a quota answer, not when every slot was already cooling down. */
  let sawQuota = false;
  /** The final response (with its bounded error body if already read), or null when every OpenAI key slot is out of quota. */
  const obtain = async (): Promise<Sent | null> => {
    if (plan.kind === "single") return send(plan.key, false);
    // Only a quota, billing or deactivation answer from the exact OpenAI host moves to the next key.
    const r = await withOpenAiKeyFailover<Sent>("chat", async (key) => {
      const sent = await send(key, true);
      if (sent.res.ok) return { outcome: "ok", value: sent };
      // The classifier reads the body exactly as before; the text it read is kept for the diagnostics line below.
      const c = await classifyOpenAiResponseDetail(url, sent.res, sent.detail);
      if (c.outcome === "quota") sawQuota = true;
      return { outcome: c.outcome, status: sent.res.status, value: { res: sent.res, detail: c.text } };
    });
    return r.kind === "exhausted" ? null : r.value;
  };

  let sent: Sent | null;
  try {
    sent = await obtain();
  } catch (e) {
    // Network error, abort or timeout: note it for /api/health and rethrow the same error unchanged.
    recordLlmOutcome("error");
    throw e;
  }
  if (!sent) {
    if (sawQuota) recordLlmOutcome("quota");
    throw new Error("LLM_QUOTA_EXHAUSTED");
  }
  const { res } = sent;
  if (!res.ok) {
    // Never waits on a new body read: diagnostics and the health outcome settle on their own (settleFailedResponse).
    settleFailedResponse(res, sent.detail, { log: true, readBody: true });
    // Status only: provider error bodies can echo prompts or account details, and callers log this message.
    throw new Error(`LLM_HTTP_${res.status}`);
  }
  let result: { text: string; truncated: boolean };
  try {
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? "").join("") : raw;
    if (typeof text !== "string") throw new Error("LLM_BAD_RESPONSE");
    const reason = data?.choices?.[0]?.finish_reason ?? data?.stop_reason;
    result = { text, truncated: reason === "length" || reason === "max_tokens" };
  } catch (e) {
    recordLlmOutcome("error");
    throw e;
  }
  recordLlmOutcome("ok");
  return result;
}

/** How long the diagnostics read of an error body may take before it gives up and cancels the body. */
export const DIAGNOSTIC_BODY_TIMEOUT_MS = 1500;

/** A failed response's body, bounded by MAX_ERROR_BODY_BYTES and DIAGNOSTIC_BODY_TIMEOUT_MS. Never throws. */
export function readDiagnosticBody(res: Response): Promise<string> {
  return readBoundedBody(res, MAX_ERROR_BODY_BYTES, DIAGNOSTIC_BODY_TIMEOUT_MS);
}

/**
 * Error type and code values that may be logged as they are. Anything else the provider sends is logged as "other",
 * so provider-controlled text (which could carry a key, a prompt or account details) never reaches the logs.
 */
const KNOWN_ERROR_FIELDS: ReadonlySet<string> = new Set([
  "authentication_error",
  "invalid_request_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
  "request_too_large",
  "invalid_api_key",
  "model_not_found",
  "rate_limit_exceeded",
  "slow_down",
  "server_error",
  "context_length_exceeded",
  ...OPENAI_QUOTA_ERROR_CODES,
]);

export interface ProviderErrorFields {
  /** An allowlisted value, "other" for any other value that is present, null when absent. */
  type: string | null;
  code: string | null;
}

const allowlisted = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" && KNOWN_ERROR_FIELDS.has(v) ? v : "other");

/**
 * The provider's error type and code from a (bounded) error body, for one diagnostics log line. Reads
 * OpenAI-style `{ error: { type, code } }` and Anthropic `{ type: "error", error: { type } }`; a top-level `type`
 * is used only when `error.type` is absent and it is not the generic "error". Every other field, the message
 * included, is ignored, and each value is either allowlisted, "other" or null.
 */
export function providerErrorFields(bodyText: string): ProviderErrorFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText.slice(0, MAX_ERROR_BODY_BYTES));
  } catch {
    return { type: null, code: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { type: null, code: null };
  const top = parsed as { type?: unknown; error?: unknown };
  const err = top.error && typeof top.error === "object" && !Array.isArray(top.error) ? (top.error as { type?: unknown; code?: unknown }) : {};
  const rawType = err.type ?? (top.type === "error" ? undefined : top.type);
  return { type: allowlisted(rawType), code: allowlisted(err.code) };
}

/**
 * The /api/health outcome for a failed response: a 429 whose type or code is a known quota code (and not an
 * ordinary rate-limit code) counts as quota, so an explicit LLM_API_KEY out of credit reads as error_quota.
 * Recording only: failover decisions stay with classifyOpenAiResponse.
 */
export function llmFailureOutcome(status: number, fields: ProviderErrorFields): LlmOutcome {
  const quota = status === 429 && classifyOpenAiFailure(429, [fields.type, fields.code]) === "quota";
  return llmOutcomeFromStatus(status, { quota });
}

/**
 * Records the /api/health outcome for a failed response, and with `log` writes the one "[llm] provider error" line,
 * without ever making the caller wait on a body read.
 * - `alreadyRead` (the temperature check's or the failover classifier's bounded text): settled synchronously.
 * - Otherwise a provisional outcome from the status is recorded at once, so health is never stale. With `readBody`,
 *   a detached read bounded by MAX_ERROR_BODY_BYTES and DIAGNOSTIC_BODY_TIMEOUT_MS then refines it (error to quota
 *   for a quota 429) and logs. It cancels the body on timeout and never rejects.
 */
export function settleFailedResponse(res: Response, alreadyRead: string | undefined, opts: { log: boolean; readBody: boolean }): void {
  const status = res.status;
  const settle = (text: string, token?: number) => {
    const fields = providerErrorFields(text);
    const outcome = llmFailureOutcome(status, fields);
    if (token === undefined) recordLlmOutcome(outcome);
    else refineLlmOutcome(token, outcome);
    // Only allowlisted error type and code values are logged: never the body, its message, the key, the URL or the model.
    if (opts.log) console.error("[llm] provider error", { status, type: fields.type, code: fields.code });
  };
  if (alreadyRead !== undefined) {
    settle(alreadyRead);
    return;
  }
  const token = recordLlmOutcome(llmOutcomeFromStatus(status));
  if (!opts.readBody) return;
  // readBoundedBody takes the body's reader before its first await, so a caller may cancel the body right after this.
  void readDiagnosticBody(res)
    .then((text) => settle(text, token))
    .catch(() => {});
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

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
import { isOpenAiBaseUrl } from "./openaiHost";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal OpenAI-compatible chat completion call (works with OpenAI, Azure,
 * OpenRouter, Ollama, vLLM...). Configure with LLM_API_KEY (or OPENAI_API_KEY and its
 * OPENAI_API_KEY_BACKUP_* failover keys, OpenAI base only), LLM_BASE_URL and LLM_MODEL.
 * Callers can pass opts.model (grading reads LLM_MODEL_GRADING from serverConfig).
 * Used for the coach, grading, the persona wizard and the text simulation; voice goes
 * through OpenAI Realtime or ElevenLabs. Throws LLM_QUOTA_EXHAUSTED when every OpenAI
 * key slot is out of quota; callers already fall back on any error.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  return (await chatFull(messages, opts)).text;
}

/** A strict JSON schema for OpenAI structured outputs (response_format type json_schema). */
export interface JsonSchemaFormat {
  /** Letters, digits, underscores and dashes, at most 64 characters. */
  name: string;
  /** Strict mode: every property listed in `required`, `additionalProperties: false` on every object. */
  schema: Record<string, unknown>;
}

export interface ChatOptions {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /**
   * Opt in to structured outputs. Used only with `json` on the OpenAI base; any other host keeps json_object.
   * A 400 that names response_format or json_schema is retried once on the same key with json_object.
   */
  jsonSchema?: JsonSchemaFormat;
  /**
   * Aborts the request in flight (combined with the 60 s per-request timeout). Once it fires, no further request
   * starts: no temperature or response_format retry and no next key in the failover ladder.
   */
  signal?: AbortSignal;
  /**
   * Treat `message.content: null` as empty text instead of throwing LLM_BAD_RESPONSE, so the caller can see the
   * finish reason (reasoning tokens can use up the budget and leave no content). A missing message still throws.
   */
  nullContentAsEmpty?: boolean;
  /**
   * Sent as `reasoning_effort` on the OpenAI base only; any other host never sees it. Lower effort spends fewer hidden
   * reasoning tokens (which count against maxTokens) and answers sooner. A 400 that mentions reasoning is retried once
   * on the same key without it.
   */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Like chat(), but also reports whether the model stopped because it hit max_tokens. */
export async function chatFull(messages: ChatMessage[], opts: ChatOptions = {}): Promise<{ text: string; truncated: boolean }> {
  // Per request: an explicit LLM_API_KEY (or no OpenAI base) never uses the OpenAI key ladder.
  const plan = chatKeyPlan(process.env);
  if (plan.kind === "none") throw new Error("LLM_NOT_CONFIGURED");
  const base = llmBaseUrl();
  const url = `${base}/chat/completions`;
  // Anthropic's OpenAI-compatible endpoint ignores response_format, so we
  // never send it there and rely on extractJson() + the prompt instead.
  const sendJsonFormat = opts.json && !/anthropic\.com/i.test(base);
  const sendJsonSchema = Boolean(sendJsonFormat && opts.jsonSchema && isOpenAiBaseUrl(base));
  const sendReasoning = Boolean(opts.reasoningEffort && isOpenAiBaseUrl(base));
  /** Called before every request: once the caller's signal fires, nothing new goes to the provider. */
  const checkAborted = () => {
    if (opts.signal?.aborted) throw new Error("LLM_ABORTED");
  };
  /**
   * One request on one key, with same-key retries without temperature, without reasoning_effort and without
   * json_schema. `pinned` refuses redirects.
   */
  const send = async (key: string, pinned: boolean) => {
    const call = (withTemperature: boolean, withSchema: boolean, withReasoning: boolean) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: opts.model ?? llmModel(),
          messages,
          ...(withTemperature ? { temperature: opts.temperature ?? 0.4 } : {}),
          // OpenAI GPT-5+/6 models reject max_tokens and need max_completion_tokens; other hosts keep max_tokens.
          ...(isOpenAiBaseUrl(base) ? { max_completion_tokens: opts.maxTokens ?? 1800 } : { max_tokens: opts.maxTokens ?? 1800 }),
          ...(withReasoning ? { reasoning_effort: opts.reasoningEffort } : {}),
          ...(withSchema && opts.jsonSchema
            ? { response_format: { type: "json_schema", json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema } } }
            : sendJsonFormat
              ? { response_format: { type: "json_object" } }
              : {}),
        }),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        ...(pinned ? { redirect: "error" as const } : {}),
      });
    // Model id only, and only outside tests: no prompts, keys, or response bodies.
    if (process.env.NODE_ENV !== "test") console.info("[llm] model", opts.model ?? llmModel());
    let withTemperature = true;
    let withSchema = sendJsonSchema;
    let withReasoning = sendReasoning;
    checkAborted();
    let res = await call(withTemperature, withSchema, withReasoning);
    let detail: string | undefined;
    // At most one retry per adjustment (three adjustments). The body is only inspected (bounded), never logged.
    for (let i = 0; i < 3 && !res.ok && res.status === 400; i++) {
      detail = await readBoundedBody(res);
      // Some newer models reject `temperature`; retry once without it.
      if (withTemperature && /temperature/i.test(detail.slice(0, 300))) withTemperature = false;
      // A model without reasoning_effort, or without the value asked for: retry once with the provider's default.
      else if (withReasoning && /reasoning/i.test(detail)) withReasoning = false;
      // A model or deployment without structured outputs: retry once with plain json_object.
      else if (withSchema && /response_format|json_schema/i.test(detail)) withSchema = false;
      else break;
      checkAborted();
      res = await call(withTemperature, withSchema, withReasoning);
      detail = undefined;
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
    // The caller's own abort says nothing about the provider, so it is not recorded.
    if (!opts.signal?.aborted) recordLlmOutcome("error");
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
    const message = data?.choices?.[0]?.message;
    const raw = opts.nullContentAsEmpty && message && typeof message === "object" && message.content === null ? "" : message?.content;
    const text = Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? "").join("") : raw;
    if (typeof text !== "string") throw new Error("LLM_BAD_RESPONSE");
    const reason = data?.choices?.[0]?.finish_reason ?? data?.stop_reason;
    result = { text, truncated: reason === "length" || reason === "max_tokens" };
  } catch (e) {
    if (!opts.signal?.aborted) recordLlmOutcome("error");
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

/**
 * The end of the balanced JSON object that starts at `start` (a "{"), or -1 when it never closes. String-aware:
 * braces inside strings and escaped quotes do not count.
 */
function balancedObjectEnd(t: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The first top-level JSON object in model text: strips code fences, ignores prose before it and text after it.
 * Only top-level spans are tried, so a truncated reply never yields one of its nested objects. Throws only
 * LLM_EMPTY or LLM_BAD_JSON, never a SyntaxError (whose message would quote the reply).
 */
export function parseFirstJsonObject(text: string): Record<string, unknown> {
  const t = text.trim();
  if (!t) throw new Error("LLM_EMPTY");
  // Fenced content first (an unclosed fence runs to the end), then the whole text.
  const fenced = t.match(/```[\w-]*[^\S\n]*\n?([\s\S]*?)(?:```|$)/);
  for (const source of fenced ? [fenced[1], t] : [t]) {
    let start = source.indexOf("{");
    while (start >= 0) {
      const end = balancedObjectEnd(source, start);
      if (end < 0) break;
      try {
        const v: unknown = JSON.parse(source.slice(start, end + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      } catch {
        /* Not JSON (prose in braces): try the next top-level span. */
      }
      start = source.indexOf("{", end + 1);
    }
  }
  throw new Error("LLM_BAD_JSON");
}

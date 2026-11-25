import "server-only";
import { chatFull, extractJson, type ChatMessage } from "./llm";
import { readBoundedBody } from "./openaiKeys";
import { OPENAI_DEFAULT_BASE_URL } from "./openaiHost";
import { anthropicKey, llmKey, wizardFallbackModel, wizardModel, wizardOpenAiKey, wizardProvider } from "./serverConfig";

/**
 * Structured JSON for the persona wizard from a dedicated builder model.
 *
 * - Anthropic (wizardProvider() === "anthropic"): the Messages API at the pinned api.anthropic.com URL, with one forced
 *   tool whose input_schema is the persona schema, so the reply is the tool's input object. The Anthropic key goes
 *   only there. On any Anthropic failure, the chat provider (LLM_API_KEY / OPENAI_API_KEY via chatFull) runs the same
 *   request when a chat key is configured; otherwise the error reaches personaWizard.ts, which uses the template.
 * - OpenAI: a dedicated WIZARD_API_KEY goes only to api.openai.com; otherwise chatFull with the configured chat key and
 *   base, strict json_schema on the OpenAI base.
 *
 * Logs carry the provider and status code only: never a key, a prompt, a model id or a response body.
 */

export interface WizardJsonRequest {
  system: string;
  user: string;
  /** Tool name (Anthropic) and json_schema name (OpenAI): letters, digits, underscores and dashes, at most 64. */
  toolName: string;
  toolDescription: string;
  /** Strict-mode schema: every property required, additionalProperties false on every object. */
  jsonSchema: Record<string, unknown>;
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_CHAT_URL = `${OPENAI_DEFAULT_BASE_URL}/chat/completions`;
const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4096;
const TEMPERATURE = 0.6;

/** A failed provider call. The message is a code (WIZARD_HTTP_500, WIZARD_TRUNCATED...), safe to log. */
export class WizardLlmError extends Error {
  constructor(code: string, readonly status: number | null = null) {
    super(code);
    this.name = "WizardLlmError";
  }
}

const logFailure = (provider: "anthropic" | "openai", status: number | null) =>
  console.error("[wizardLlm] provider error", { provider, status });

/** Discards a body we will not read, so the connection is released. */
const discard = (res: Response) => {
  void res.body?.cancel().catch(() => {});
};

/**
 * POST with one same-key retry when a 400 names temperature or reasoning (some models reject them). The 400 body is
 * only inspected, bounded, never logged.
 */
async function postJson(
  provider: "anthropic" | "openai",
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  retryWithout: string[],
): Promise<Response> {
  const send = (b: Record<string, unknown>) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(b), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  let res: Response;
  try {
    res = await send(body);
    if (res.status === 400) {
      const detail = await readBoundedBody(res);
      if (/temperature|reasoning/i.test(detail)) {
        const lean = { ...body };
        for (const k of retryWithout) delete lean[k];
        res = await send(lean);
      } else {
        logFailure(provider, 400);
        throw new WizardLlmError("WIZARD_HTTP_400", 400);
      }
    }
  } catch (e) {
    if (e instanceof WizardLlmError) throw e;
    // Network error, refused redirect or timeout. The thrown message is not logged: it can name the URL.
    logFailure(provider, null);
    throw new WizardLlmError(e instanceof Error && e.name === "TimeoutError" ? "WIZARD_TIMEOUT" : "WIZARD_NETWORK", null);
  }
  if (!res.ok) {
    discard(res);
    logFailure(provider, res.status);
    throw new WizardLlmError(`WIZARD_HTTP_${res.status}`, res.status);
  }
  return res;
}

/** Anthropic Messages API with a forced tool: the tool_use block's input is the JSON object. */
async function viaAnthropic(args: WizardJsonRequest, key: string): Promise<unknown> {
  const res = await postJson(
    "anthropic",
    ANTHROPIC_MESSAGES_URL,
    { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    {
      model: wizardModel(),
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: args.system,
      tools: [{ name: args.toolName, description: args.toolDescription, input_schema: args.jsonSchema }],
      tool_choice: { type: "tool", name: args.toolName },
      messages: [{ role: "user", content: args.user }],
    },
    ["temperature"],
  );
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new WizardLlmError("WIZARD_BAD_RESPONSE");
  }
  const d = data as { stop_reason?: unknown; content?: unknown } | null;
  if (d?.stop_reason === "max_tokens") throw new WizardLlmError("WIZARD_TRUNCATED");
  const blocks = Array.isArray(d?.content) ? (d.content as { type?: unknown; name?: unknown; input?: unknown }[]) : [];
  const tool = blocks.find((b) => b && b.type === "tool_use" && b.name === args.toolName) ?? blocks.find((b) => b && b.type === "tool_use");
  if (!tool || !tool.input || typeof tool.input !== "object" || Array.isArray(tool.input)) throw new WizardLlmError("WIZARD_BAD_RESPONSE");
  return tool.input;
}

/** A dedicated WIZARD_API_KEY on the pinned OpenAI host, with strict structured outputs. */
async function viaOpenAiDirect(args: WizardJsonRequest, key: string): Promise<unknown> {
  const res = await postJson(
    "openai",
    OPENAI_CHAT_URL,
    { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    {
      model: wizardModel(),
      messages: messagesOf(args),
      temperature: TEMPERATURE,
      max_completion_tokens: MAX_TOKENS,
      reasoning_effort: "medium",
      response_format: { type: "json_schema", json_schema: { name: args.toolName, strict: true, schema: args.jsonSchema } },
    },
    ["temperature", "reasoning_effort"],
  );
  let data: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null;
  try {
    data = await res.json();
  } catch {
    throw new WizardLlmError("WIZARD_BAD_RESPONSE");
  }
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === "length") throw new WizardLlmError("WIZARD_TRUNCATED");
  const text = choice?.message?.content;
  if (typeof text !== "string") throw new WizardLlmError("WIZARD_BAD_RESPONSE");
  return extractJson(text);
}

const messagesOf = (args: WizardJsonRequest): ChatMessage[] => [
  { role: "system", content: args.system },
  { role: "user", content: args.user },
];

/** The configured chat provider (chatFull: key ladder, base URL, structured outputs on the OpenAI base). */
async function viaChat(args: WizardJsonRequest, model: string): Promise<unknown> {
  const { text, truncated } = await chatFull(messagesOf(args), {
    json: true,
    jsonSchema: { name: args.toolName, schema: args.jsonSchema },
    maxTokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    model,
    reasoningEffort: "medium",
  });
  if (truncated) throw new WizardLlmError("WIZARD_TRUNCATED");
  return extractJson(text);
}

/**
 * One structured JSON object from the wizard's builder model. Throws (WIZARD_* or LLM_* codes) when no provider
 * produced one; the caller falls back to its template.
 */
export async function generateWizardJson(args: WizardJsonRequest): Promise<unknown> {
  const provider = wizardProvider();
  if (provider === "anthropic") {
    const key = anthropicKey();
    if (!key) throw new WizardLlmError("WIZARD_NOT_CONFIGURED");
    try {
      return await viaAnthropic(args, key);
    } catch (e) {
      // The chat provider gets the same request; it never sees the Anthropic key.
      if (!llmKey()) throw e;
      console.error("[wizardLlm] falling back to the chat provider", { code: e instanceof WizardLlmError ? e.message : "WIZARD_ERROR" });
      return viaChat(args, wizardFallbackModel());
    }
  }
  if (provider === "openai") {
    const dedicated = wizardOpenAiKey();
    return dedicated ? viaOpenAiDirect(args, dedicated) : viaChat(args, wizardModel());
  }
  throw new WizardLlmError("WIZARD_NOT_CONFIGURED");
}

/**
 * Plain-language results for POST /api/llm/check. Pure and client-safe so the
 * Models page can share the result type. Hints name env vars, never values:
 * no key, no endpoint URL, no provider error text.
 */

export type CheckFailure = "no_key" | "http" | "timeout" | "network" | "bad_response";

export interface LlmCheckResult {
  ok: boolean;
  /** Round-trip time of the test call; null when no call was made or it never answered. */
  latencyMs: number | null;
  model: string;
  /** Provider HTTP status; null when there was no response. */
  status: number | null;
  hint: string;
}

export const CHECK_TIMEOUT_MS = 15_000;

export function checkHint({ ok, status, model, failure }: { ok: boolean; status: number | null; model: string; failure?: CheckFailure }): string {
  if (ok) return `Connected. The key works and ${model} answered.`;
  switch (failure) {
    case "no_key":
      return "No API key is set. Add LLM_API_KEY to the server environment and restart. Until then the app uses the rules-based coach and grader, the scripted caller and the template wizard.";
    case "timeout":
      return `The provider didn't answer within ${CHECK_TIMEOUT_MS / 1000} seconds. Check the server's network and LLM_BASE_URL, then try again.`;
    case "network":
      return "The server couldn't reach the provider. Check the server's network and LLM_BASE_URL, then try again.";
    case "bad_response":
      return "The endpoint answered, but not like an OpenAI-compatible chat API. Check that LLM_BASE_URL points at a /v1 chat completions API.";
  }
  if (status === 401) return "The provider rejected the API key. Check that LLM_API_KEY is correct and hasn't been revoked.";
  if (status === 403) return "The key was accepted but isn't allowed to make this call. Check the key's permissions, project or organization access.";
  if (status === 404) return `This key can't use the model ${model}, or the endpoint doesn't exist. Set LLM_MODEL to a model your account can use, and check LLM_BASE_URL.`;
  if (status === 429) return "The provider is rate limiting this key, or the account is out of quota. Check billing and usage limits, then try again.";
  if (status !== null && status >= 500) return `The provider had a server error (HTTP ${status}). Try again in a few minutes.`;
  return `The provider refused the test call (HTTP ${status ?? "unknown"}). Check that LLM_MODEL is a chat model this endpoint supports.`;
}

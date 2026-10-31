import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { llmBaseUrl, llmKey, llmModel } from "@/lib/serverConfig";
import { paidFeaturesGuard } from "@/lib/spendGuard";
import { CHECK_TIMEOUT_MS, checkHint, type CheckFailure, type LlmCheckResult } from "../hints";

const CHECK_LIMIT = 6;
const CHECK_WINDOW_MS = 10 * 60_000;
// Per account as well, so switching networks doesn't buy unlimited calls on the operator's key.
const USER_CHECK_LIMIT = 20;
const USER_CHECK_WINDOW_MS = 60 * 60_000;

function limited(retryAfterMs: number, what: string) {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const mins = Math.ceil(retryAfter / 60);
  return NextResponse.json(
    { error: "rate_limited", message: `You've checked the connection ${what}. Wait ${mins} minute${mins === 1 ? "" : "s"} and try again.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

function result(r: Omit<LlmCheckResult, "hint">, failure?: CheckFailure) {
  return NextResponse.json({ ...r, hint: checkHint({ ok: r.ok, status: r.status, model: r.model, failure }) } satisfies LlmCheckResult);
}

/**
 * Makes one minimal chat completion (max_tokens 1) with the configured key and
 * model and reports what happened in plain language. The provider's error body
 * is never read or echoed, and neither the key nor the endpoint URL is returned.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  // Even one token is a paid completion, so the check is off with the rest.
  const paused = paidFeaturesGuard();
  if (paused) return paused;

  const ipLimit = rateLimit({ key: `llmcheck:${clientIp(req)}`, limit: CHECK_LIMIT, windowMs: CHECK_WINDOW_MS });
  if (!ipLimit.allowed) return limited(ipLimit.retryAfterMs, `${CHECK_LIMIT} times in 10 minutes`);
  const userLimit = rateLimit({ key: `llmcheck-user:${auth.id}`, limit: USER_CHECK_LIMIT, windowMs: USER_CHECK_WINDOW_MS });
  if (!userLimit.allowed) return limited(userLimit.retryAfterMs, `${USER_CHECK_LIMIT} times in the last hour`);

  const model = llmModel();
  const key = llmKey();
  if (!key) return result({ ok: false, latencyMs: null, model, status: null }, "no_key");

  const started = Date.now();
  try {
    const res = await fetch(`${llmBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1 }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      console.warn("[llm/check] provider status", res.status);
      return result({ ok: false, latencyMs, model, status: res.status }, "http");
    }
    const data = await res.json().catch(() => null);
    const shaped = Array.isArray((data as { choices?: unknown } | null)?.choices);
    return result({ ok: shaped, latencyMs, model, status: res.status }, shaped ? undefined : "bad_response");
  } catch (e) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError; read the name without relying on instanceof.
    const name = (e as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.warn("[llm/check]", timedOut ? "timeout" : "network error");
    return result({ ok: false, latencyMs: null, model, status: null }, timedOut ? "timeout" : "network");
  }
}

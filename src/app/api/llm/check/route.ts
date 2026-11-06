import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { chatKeyPlan, classifyOpenAiResponse, withOpenAiKeyFailover } from "@/lib/openaiKeys";
import { llmBaseUrl, llmModel } from "@/lib/serverConfig";
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

/** Builds the response field by field, so nothing beyond ok, latency, status and the hint can reach the browser. */
function result(r: Omit<LlmCheckResult, "hint">, failure?: CheckFailure) {
  const body: LlmCheckResult = { ok: r.ok, latencyMs: r.latencyMs, status: r.status, hint: checkHint({ ok: r.ok, status: r.status, failure }) };
  return NextResponse.json(body);
}

/**
 * Makes one minimal chat completion (max_tokens 1) with the configured key and
 * model and reports what happened in plain language. The provider's error body
 * is never echoed, and neither the key, the endpoint URL nor the model id is returned.
 *
 * With the OpenAI key ladder (LLM_API_KEY unset, OpenAI base) it goes through withOpenAiKeyFailover like a real
 * request: a quota answer moves to the next key slot, reading at most 8 KiB of that body for error.code and
 * error.type only. At most one billable 1-token call is made; refused quota calls cost nothing. The response never
 * says which slot answered: slot health is for platform admins and cron (/api/cron/openai-keys).
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimit = rateLimit({ key: `llmcheck:${clientIp(req)}`, limit: CHECK_LIMIT, windowMs: CHECK_WINDOW_MS });
  if (!ipLimit.allowed) return limited(ipLimit.retryAfterMs, `${CHECK_LIMIT} times in 10 minutes`);
  const userLimit = rateLimit({ key: `llmcheck-user:${auth.id}`, limit: USER_CHECK_LIMIT, windowMs: USER_CHECK_WINDOW_MS });
  if (!userLimit.allowed) return limited(userLimit.retryAfterMs, `${USER_CHECK_LIMIT} times in the last hour`);

  const model = llmModel();
  const plan = chatKeyPlan(process.env);
  if (plan.kind === "none") return result({ ok: false, latencyMs: null, status: null }, "no_key");

  const url = `${llmBaseUrl()}/chat/completions`;
  const send = async (key: string, pinned: boolean) => {
    const started = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1 }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: "no-store",
      ...(pinned ? { redirect: "error" as const } : {}),
    });
    return { res, latencyMs: Date.now() - started };
  };

  try {
    let sent: Awaited<ReturnType<typeof send>>;
    if (plan.kind === "single") {
      sent = await send(plan.key, false);
    } else {
      const r = await withOpenAiKeyFailover("check", async (key) => {
        const s = await send(key, true);
        if (s.res.ok) return { outcome: "ok", value: s };
        return { outcome: await classifyOpenAiResponse(url, s.res), status: s.res.status, value: s };
      });
      if (r.kind === "exhausted") {
        console.warn("[llm/check] all OpenAI key slots out of quota");
        return result({ ok: false, latencyMs: r.last?.latencyMs ?? null, status: r.status }, "quota_exhausted");
      }
      sent = r.value;
    }
    const { res, latencyMs } = sent;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      console.warn("[llm/check] provider status", res.status);
      return result({ ok: false, latencyMs, status: res.status }, "http");
    }
    const data = await res.json().catch(() => null);
    const shaped = Array.isArray((data as { choices?: unknown } | null)?.choices);
    return result({ ok: shaped, latencyMs, status: res.status }, shaped ? undefined : "bad_response");
  } catch (e) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError; read the name without relying on instanceof.
    const name = (e as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.warn("[llm/check]", timedOut ? "timeout" : "network error");
    return result({ ok: false, latencyMs: null, status: null }, timedOut ? "timeout" : "network");
  }
}

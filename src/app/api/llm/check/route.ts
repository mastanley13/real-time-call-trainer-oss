import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { LLM_ROLES, llmBaseUrlFor, llmKeyFor, llmModel, llmModelFor, type LlmRole } from "@/lib/serverConfig";
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

type One = { ok: boolean; latencyMs: number | null; status: number | null; failure?: CheckFailure };

/** One minimal chat completion against one endpoint, model and key. */
async function checkOne(base: string, model: string, key: string): Promise<One> {
  const started = Date.now();
  const send = (completionTokens: boolean) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], [completionTokens ? "max_completion_tokens" : "max_tokens"]: 1 }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      cache: "no-store",
    });
  try {
    let res = await send(false);
    if (res.status === 400) {
      // Newer models want max_completion_tokens. The body is only inspected for the parameter name, never echoed.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (/max_tokens/i.test(detail)) res = await send(true);
    }
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      console.warn("[llm/check] provider status", res.status);
      return { ok: false, latencyMs, status: res.status, failure: "http" };
    }
    const data = await res.json().catch(() => null);
    const shaped = Array.isArray((data as { choices?: unknown } | null)?.choices);
    return { ok: shaped, latencyMs, status: res.status, ...(shaped ? {} : { failure: "bad_response" as const }) };
  } catch (e) {
    // AbortSignal.timeout rejects with a DOMException named TimeoutError; read the name without relying on instanceof.
    const name = (e as { name?: unknown } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    console.warn("[llm/check]", timedOut ? "timeout" : "network error");
    return { ok: false, latencyMs: null, status: null, failure: timedOut ? "timeout" : "network" };
  }
}

/**
 * Makes one minimal chat completion (max_tokens 1) for every distinct configured role setup (endpoint, model
 * and key) and reports what happened in plain language. The provider's error body is never echoed, and neither
 * the key nor the endpoint URL is returned.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimit = rateLimit({ key: `llmcheck:${clientIp(req)}`, limit: CHECK_LIMIT, windowMs: CHECK_WINDOW_MS });
  if (!ipLimit.allowed) return limited(ipLimit.retryAfterMs, `${CHECK_LIMIT} times in 10 minutes`);
  const userLimit = rateLimit({ key: `llmcheck-user:${auth.id}`, limit: USER_CHECK_LIMIT, windowMs: USER_CHECK_WINDOW_MS });
  if (!userLimit.allowed) return limited(userLimit.retryAfterMs, `${USER_CHECK_LIMIT} times in the last hour`);

  // Roles that share an endpoint, model and key are checked once.
  const groups = new Map<string, { roles: LlmRole[]; base: string; model: string; key: string }>();
  for (const role of LLM_ROLES) {
    const key = llmKeyFor(role);
    if (!key) continue;
    const base = llmBaseUrlFor(role);
    const model = llmModelFor(role);
    const id = JSON.stringify([base, model, key]);
    const g = groups.get(id);
    if (g) g.roles.push(role);
    else groups.set(id, { roles: [role], base, model, key });
  }
  if (groups.size === 0) return result({ ok: false, latencyMs: null, model: llmModel(), status: null }, "no_key");

  const checked: (One & { roles: LlmRole[]; model: string })[] = [];
  for (const g of groups.values()) checked.push({ roles: g.roles, model: g.model, ...(await checkOne(g.base, g.model, g.key)) });
  // The headline is the first failure, else the first group; every group is listed in `checks`.
  const head = checked.find((c) => !c.ok) ?? checked[0];
  const latencies = checked.map((c) => c.latencyMs).filter((n): n is number => n !== null);
  return NextResponse.json({
    ok: checked.every((c) => c.ok),
    latencyMs: latencies.length ? Math.max(...latencies) : null,
    model: head.model,
    status: head.status,
    hint: checkHint({ ok: head.ok, status: head.status, model: head.model, failure: head.failure }),
    checks: checked.map((c) => ({ roles: c.roles, model: c.model, ok: c.ok, latencyMs: c.latencyMs, status: c.status })),
  } satisfies LlmCheckResult);
}

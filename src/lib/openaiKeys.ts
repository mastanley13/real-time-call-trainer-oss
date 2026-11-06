import "server-only";
import { safeEqual } from "./access";
import { OPENAI_DEFAULT_BASE_URL, isOpenAiBaseUrl } from "./openaiHost";

/**
 * OpenAI key failover. When the account or project behind a key is out of quota, out of billing or deactivated,
 * the request that saw it is sent once more on the next configured key, in a fixed order. Every other failure
 * (ordinary rate limits, 5xx, network errors, timeouts, bad keys, bad requests) behaves exactly as before.
 *
 * Slots, skipping any that is unset, blank, or equal to an earlier slot (constant-time compare):
 *   0 OPENAI_API_KEY, 1 OPENAI_API_KEY_BACKUP_1, 2 OPENAI_API_KEY_BACKUP_2.
 *
 * Boundaries (see chatKeyPlan and voiceKeyPlan):
 * - Chat: an explicit LLM_API_KEY is used alone, as before. The ladder runs only when LLM_API_KEY is unset and
 *   LLM_BASE_URL is the exact OpenAI host, evaluated per request. A custom base URL never gets a slot's key.
 * - Voice: an explicit OPENAI_REALTIME_API_KEY is used alone, as before. Otherwise the ladder, and LLM_API_KEY only
 *   as a last resort when no slot is configured.
 * - The classifier runs only on responses from the exact OpenAI host. Ladder requests use redirect: "error", so a
 *   key never follows a redirect.
 *
 * State is in memory, per process. On serverless each instance learns on its own that a slot is exhausted; a
 * refused quota request costs nothing. Logs and the sink carry slot numbers only: never a key, part of a key, a
 * hash of a key, a provider body, a model id, a user or a URL.
 */

type Env = Record<string, string | undefined>;

export const OPENAI_KEY_SLOT_VARS = ["OPENAI_API_KEY", "OPENAI_API_KEY_BACKUP_1", "OPENAI_API_KEY_BACKUP_2"] as const;

/**
 * error.code / error.type values that mean the key's account or project cannot pay for requests.
 *
 * Checked 2026-11-05 against https://platform.openai.com/docs/guides/error-codes. That page documents HTTP 429 with
 * the codes credit_balance_exhausted, organization_spend_limit_exceeded, project_spend_limit_exceeded and
 * organization_usage_limit_exceeded, under the broader error.type insufficient_quota (older responses also sent
 * insufficient_quota as error.code). The last three entries are a legacy allowlist kept for older or other
 * responses; they are not all listed on the current page. Never match on the human message text.
 */
export const OPENAI_QUOTA_ERROR_CODES = [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  // Legacy, not all on the current docs page.
  "billing_hard_limit_reached",
  "billing_not_active",
  "account_deactivated",
] as const;

/** Statuses that may carry a quota answer. A 5xx never fails over, whatever its body says. */
export const OPENAI_FAILOVER_STATUSES = [400, 401, 403, 429] as const;

/** Ordinary rate limits. They win over anything else in the same body, so they never fail over. */
const ORDINARY_RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "slow_down"]);

/** How long an exhausted slot is skipped before it is tried again (first), so the server recovers on its own. */
export const QUOTA_COOLDOWN_MS = 15 * 60_000;

/** At most this much of an error body is read, only to find error.code and error.type. */
export const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_CODE_CHARS = 64;

const QUOTA_CODES: ReadonlySet<string> = new Set(OPENAI_QUOTA_ERROR_CODES);
const GATE: ReadonlySet<number> = new Set(OPENAI_FAILOVER_STATUSES);

export type KeySurface = "chat" | "realtime" | "check";
export type FailureClass = "quota" | "other";

/* ---------- Slots and plans ---------- */

export interface KeySlot { slot: number; key: string }
type SlotConfig = { slot: number; status: "configured" | "duplicate" | "not_configured"; key?: string };

function slotConfigs(env: Env): SlotConfig[] {
  const seen: string[] = [];
  return OPENAI_KEY_SLOT_VARS.map((name, slot) => {
    const key = env[name]?.trim();
    if (!key) return { slot, status: "not_configured" };
    // Compare against every earlier value without short-circuiting.
    let duplicate = false;
    for (const s of seen) duplicate = safeEqual(s, key) || duplicate;
    seen.push(key);
    return duplicate ? { slot, status: "duplicate" } : { slot, status: "configured", key };
  });
}

/** Usable slots in fixed order: unset, blank and duplicate slots are skipped. Server-only; never log the result. */
export function openAiKeySlots(env: Env = process.env): KeySlot[] {
  return slotConfigs(env).flatMap((c) => (c.status === "configured" && c.key ? [{ slot: c.slot, key: c.key }] : []));
}

export type KeyPlan = { kind: "none" } | { kind: "single"; key: string } | { kind: "ladder"; slots: KeySlot[] };

const llmBaseOf = (env: Env) => env.LLM_BASE_URL || OPENAI_DEFAULT_BASE_URL;

/** Chat, grading, wizard, text caller and the connection check. Read per request, never cached. */
export function chatKeyPlan(env: Env = process.env): KeyPlan {
  const own = env.LLM_API_KEY?.trim();
  if (own) return { kind: "single", key: own };
  if (!isOpenAiBaseUrl(llmBaseOf(env))) return { kind: "none" };
  const slots = openAiKeySlots(env);
  return slots.length ? { kind: "ladder", slots } : { kind: "none" };
}

/** Realtime voice. The upstream URL is hard-coded to OpenAI, so every key here only ever goes there. */
export function voiceKeyPlan(env: Env = process.env): KeyPlan {
  const explicit = env.OPENAI_REALTIME_API_KEY?.trim();
  if (explicit) return { kind: "single", key: explicit };
  const slots = openAiKeySlots(env);
  if (slots.length) return { kind: "ladder", slots };
  const llm = env.LLM_API_KEY?.trim();
  if (llm && isOpenAiBaseUrl(llmBaseOf(env))) return { kind: "single", key: llm };
  return { kind: "none" };
}

/* ---------- Classification (reads a bounded body, keeps only two short fields) ---------- */

/** Quota only for a gated status and an allowlisted code or type; an ordinary rate-limit code always wins. */
export function classifyOpenAiFailure(
  status: number,
  codeOrType: string | null | undefined | ReadonlyArray<string | null | undefined>,
): FailureClass {
  if (!GATE.has(status)) return "other";
  const values = (Array.isArray(codeOrType) ? codeOrType : [codeOrType]).filter((v): v is string => typeof v === "string");
  if (values.some((v) => ORDINARY_RATE_LIMIT_CODES.has(v))) return "other";
  return values.some((v) => QUOTA_CODES.has(v)) ? "quota" : "other";
}

/** Reads at most `max` bytes of the body, then cancels the rest. Never throws; an unreadable body reads as "". */
export async function readBoundedBody(res: Response, max = MAX_ERROR_BODY_BYTES): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!res.body) return "";
    reader = res.body.getReader();
  } catch {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.subarray(0, max - total);
      chunks.push(take);
      total += take.length;
    }
  } catch {
    /* a broken stream reads as whatever arrived */
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/** error.code and error.type when they are strings of 64 characters or fewer. Anything else in the body is dropped. */
export function openAiErrorFields(text: string): { code?: string; type?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const err = (parsed as { error?: unknown } | null)?.error;
  if (!err || typeof err !== "object") return {};
  const pick = (v: unknown) => (typeof v === "string" && v.length <= MAX_CODE_CHARS ? v : undefined);
  const { code, type } = err as { code?: unknown; type?: unknown };
  return { code: pick(code), type: pick(type) };
}

/**
 * Classifies a non-OK response. Runs only for the exact OpenAI host and a gated status; otherwise the body is left
 * alone and the answer is "other". `alreadyRead` is a body the caller has read already (bounded), for example the
 * 400 that the temperature retry inspected. The body is never returned, logged or stored.
 */
export async function classifyOpenAiResponse(url: string, res: Response, alreadyRead?: string): Promise<FailureClass> {
  if (res.ok || res.redirected || !isOpenAiBaseUrl(url) || !GATE.has(res.status)) return "other";
  const text = alreadyRead ?? (await readBoundedBody(res));
  const { code, type } = openAiErrorFields(text.slice(0, MAX_ERROR_BODY_BYTES));
  return classifyOpenAiFailure(res.status, [code, type]);
}

/* ---------- Per-process slot state ---------- */

type SlotStateName = "unknown" | "ok" | "quota_exhausted";
interface SlotState { slot: number; state: SlotStateName; exhaustedAt?: number; lastOkAt?: number }
interface LastFailover { from: number; to: number; at: number; surface: KeySurface; reason: "quota" }

const states = new Map<number, SlotState>();
let lastFailover: LastFailover | null = null;
/** `${from}>${to}` -> when its failover line was last logged, for one line per pair per cooldown window. */
const failoverLoggedAt = new Map<string, number>();

const stateOf = (slot: number): SlotState => states.get(slot) ?? { slot, state: "unknown" };

const coolingDown = (slot: number, now: number) => {
  const s = states.get(slot);
  return s?.state === "quota_exhausted" && s.exhaustedAt !== undefined && now - s.exhaustedAt < QUOTA_COOLDOWN_MS;
};

/** Test-only: forget all slot state, dedupe windows and the sink. */
export function resetOpenAiKeyState(): void {
  states.clear();
  failoverLoggedAt.clear();
  lastFailover = null;
  sink = null;
}

/* ---------- Logging and the notification hook ---------- */

export type KeyFailoverEvent =
  | { kind: "failover"; surface: KeySurface; from: number; to: number; at: string }
  | { kind: "exhausted"; surface: KeySurface; tried: number[]; at: string }
  | { kind: "recovered"; surface: KeySurface; slot: number; at: string };
export type KeyFailoverSink = (event: KeyFailoverEvent) => void | Promise<void>;

let sink: KeyFailoverSink | null = null;

/** In-process hook for a future notifier. Fire and forget: a throwing or rejecting sink never affects a request. */
export function setKeyFailoverSink(next: KeyFailoverSink | null): void {
  sink = next;
}

function notify(event: KeyFailoverEvent): void {
  const s = sink;
  if (!s) return;
  try {
    const r = s(event);
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => logLine("warn", { event: "openai_key_sink_failed" }));
  } catch {
    logLine("warn", { event: "openai_key_sink_failed" });
  }
}

/** One JSON line. Callers pass only the fixed fields below; nothing else is ever added. */
function logLine(level: "warn" | "info", fields: { event: string; surface?: KeySurface; from?: number; to?: number; reason?: "quota"; status?: number | null; tried?: number[]; slot?: number }): void {
  const line = JSON.stringify(fields);
  if (level === "warn") console.warn(line);
  else console.info(line);
}

function markOk(slot: number, surface: KeySurface, now: number): void {
  const prev = stateOf(slot);
  states.set(slot, { slot, state: "ok", lastOkAt: now });
  if (prev.state === "quota_exhausted") {
    logLine("warn", { event: "openai_key_recovered", slot });
    notify({ kind: "recovered", surface, slot, at: new Date(now).toISOString() });
  }
  logLine("info", { event: "openai_key_served", surface, slot });
}

function markExhausted(slot: number, now: number): void {
  const prev = stateOf(slot);
  states.set(slot, { slot, state: "quota_exhausted", exhaustedAt: now, ...(prev.lastOkAt !== undefined ? { lastOkAt: prev.lastOkAt } : {}) });
}

function noteFailover(surface: KeySurface, from: number, to: number, status: number, now: number): void {
  lastFailover = { from, to, at: now, surface, reason: "quota" };
  const pair = `${from}>${to}`;
  const logged = failoverLoggedAt.get(pair);
  if (logged !== undefined && now - logged < QUOTA_COOLDOWN_MS) return;
  failoverLoggedAt.set(pair, now);
  logLine("warn", { event: "openai_key_failover", surface, from, to, reason: "quota", status });
  notify({ kind: "failover", surface, from, to, at: new Date(now).toISOString() });
}

/* ---------- The ladder ---------- */

export type AttemptOutcome<T> = { outcome: "ok"; value: T } | { outcome: FailureClass; status: number; value: T };
export type FailoverResult<T> =
  | { kind: "ok"; slot: number; value: T }
  | { kind: "other"; slot: number; status: number; value: T }
  /** Every usable slot answered with quota, or all were cooling down (tried is then empty). */
  | { kind: "exhausted"; tried: number[]; status: number | null; last?: T };

/**
 * Runs `attempt` on the lowest slot that is not cooling down; on a quota answer marks that slot and moves to the
 * next, once per slot. Any other failure is returned as is, and a thrown error (network, abort, timeout) propagates
 * with no further attempt, so non-quota behaviour, retries included, is exactly what the caller did before.
 */
export async function withOpenAiKeyFailover<T>(
  surface: KeySurface,
  attempt: (key: string, slot: number) => Promise<AttemptOutcome<T>>,
  env: Env = process.env,
): Promise<FailoverResult<T>> {
  const start = Date.now();
  const slots = openAiKeySlots(env).filter((s) => !coolingDown(s.slot, start));
  const tried: number[] = [];
  let status: number | null = null;
  let last: T | undefined;
  for (let i = 0; i < slots.length; i++) {
    const { slot, key } = slots[i];
    tried.push(slot);
    const r = await attempt(key, slot);
    const now = Date.now();
    if (r.outcome === "ok") {
      markOk(slot, surface, now);
      return { kind: "ok", slot, value: r.value };
    }
    if (r.outcome === "other") return { kind: "other", slot, status: r.status, value: r.value };
    markExhausted(slot, now);
    status = r.status;
    last = r.value;
    const next = slots[i + 1];
    if (next) noteFailover(surface, slot, next.slot, r.status, now);
  }
  if (tried.length) {
    logLine("warn", { event: "openai_key_exhausted", surface, tried, status });
    notify({ kind: "exhausted", surface, tried: [...tried], at: new Date().toISOString() });
  }
  return { kind: "exhausted", tried, status, ...(last !== undefined ? { last } : {}) };
}

/* ---------- Health (admin and cron only; this instance's memory, no side effects) ---------- */

export type SlotHealth =
  | { slot: number; configured: true; state: SlotStateName; exhaustedAt: string | null; lastOkAt: string | null }
  | { slot: number; configured: true; state: "duplicate" }
  | { slot: number; configured: false; state: "not_configured" };

export interface OpenAiKeyHealth {
  scope: "this_instance";
  slots: SlotHealth[];
  realtime: { explicitKey: boolean };
  chat: { explicitKey: boolean; openAiBase: boolean };
  lastFailover: { from: number; to: number; surface: KeySurface; at: string } | null;
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/** Reads memory and env presence only. Never calls OpenAI, resets a cooldown or writes anything. */
export function openAiKeyHealth(env: Env = process.env): OpenAiKeyHealth {
  const slots: SlotHealth[] = slotConfigs(env).map((c) => {
    if (c.status === "not_configured") return { slot: c.slot, configured: false, state: "not_configured" };
    if (c.status === "duplicate") return { slot: c.slot, configured: true, state: "duplicate" };
    const s = stateOf(c.slot);
    return { slot: c.slot, configured: true, state: s.state, exhaustedAt: iso(s.exhaustedAt), lastOkAt: iso(s.lastOkAt) };
  });
  return {
    scope: "this_instance",
    slots,
    realtime: { explicitKey: Boolean(env.OPENAI_REALTIME_API_KEY?.trim()) },
    chat: { explicitKey: Boolean(env.LLM_API_KEY?.trim()), openAiBase: isOpenAiBaseUrl(llmBaseOf(env)) },
    lastFailover: lastFailover ? { from: lastFailover.from, to: lastFailover.to, surface: lastFailover.surface, at: new Date(lastFailover.at).toISOString() } : null,
  };
}

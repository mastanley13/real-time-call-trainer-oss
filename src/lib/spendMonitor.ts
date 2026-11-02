import "server-only";
import { prisma } from "@/lib/db";
import { THRESHOLD_PERCENTS, TRIP_PERCENT, spendConfig, type SpendConfig } from "@/lib/spendConfig";
import { STATE_ID, rememberSpendTrip } from "@/lib/spendState";

/**
 * Hourly OpenAI spend monitor (STR-691). Heavy early monitoring so the $500 credit is never exceeded.
 *
 * Each run reads the Costs API for the configured project since SPEND_BUDGET_START (all pages), plus
 * today's Completions usage for context, then:
 *   - alerts once per budget period at 50%, 75% and 90% of SPEND_BUDGET_USD ($250 / $375 / $450 by default);
 *   - trips the durable kill switch (SpendState.tripped) at 90%;
 *   - trips it once SPEND_CREDIT_EXPIRES_AT has passed, unless SPEND_ALLOW_CARD_CHARGES=true, because any
 *     spend after the credit is gone lands on the card through auto-recharge;
 *   - marks today's ceiling hit (paid routes off until midnight UTC) when SPEND_DAILY_CEILING_USD is set and
 *     today's cost reached it.
 *
 * This is a backstop. The Costs API lags real usage, so the OpenAI project's own hard budget limit stays the
 * final stop. Clearing a trip is manual (POST /api/spend/reset); a condition that still holds trips again on
 * the next run.
 *
 * Never logs the admin key or provider response bodies: errors carry an HTTP status or a fixed code only.
 */

const OPENAI_API = "https://api.openai.com/v1";
const PAGE_LIMIT = 180; // the Costs API maximum
const MAX_PAGES = 20;
const FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;

export type MonitorStatus = "ok" | "tripped" | "not_configured" | "error";

export interface SpendAlert {
  event: "spend.threshold" | "spend.tripped" | "spend.daily_ceiling" | "spend.monitor_error";
  [key: string]: unknown;
}

export interface MonitorResult {
  status: MonitorStatus;
  missing?: string[];
  invalid?: string[];
  error?: string;
  periodCostUsd?: number;
  todayCostUsd?: number;
  budgetUsd?: number;
  percentUsed?: number;
  alerted?: number[];
  tripped?: boolean;
  tripReason?: string | null;
  dailyCeilingHit?: boolean;
  usageToday?: { requests: number; inputTokens: number; outputTokens: number } | null;
}

class MonitorError extends Error {}

const unix = (ms: number) => Math.floor(ms / 1000);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const roundCents = (n: number) => Math.round(n * 100) / 100;

async function getJson(path: string, params: URLSearchParams, adminKey: string, code: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${OPENAI_API}${path}?${params}`, {
      headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new MonitorError(`${code}_unreachable`);
  }
  // Status only: the body is never read on failure, so nothing from it can reach a log.
  if (!res.ok) throw new MonitorError(`${code}_http_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new MonitorError(`${code}_bad_json`);
  }
}

interface Page {
  data?: Array<{ start_time?: number; results?: Array<Record<string, unknown>> }>;
  has_more?: boolean;
  next_page?: string | null;
}

/** Every bucket from `start` to `end`, following next_page. */
async function fetchAllBuckets(path: string, base: URLSearchParams, adminKey: string, code: string) {
  const buckets: NonNullable<Page["data"]> = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams(base);
    if (page) params.set("page", page);
    const body = (await getJson(path, params, adminKey, code)) as Page;
    if (!body || !Array.isArray(body.data)) throw new MonitorError(`${code}_bad_shape`);
    buckets.push(...body.data);
    if (!body.has_more) return buckets;
    if (!body.next_page) throw new MonitorError(`${code}_bad_shape`);
    page = body.next_page;
  }
  throw new MonitorError(`${code}_too_many_pages`);
}

/**
 * Total cost since the budget start and today's cost (UTC), in USD, for the configured project.
 * Results are grouped by project_id and anything tagged with another project is skipped, so the total stays
 * right even if the project filter were ignored.
 */
export async function fetchProjectCosts(config: SpendConfig, now = Date.now()): Promise<{ periodCostUsd: number; todayCostUsd: number }> {
  const params = new URLSearchParams({
    start_time: String(unix(config.budgetStart.getTime())),
    end_time: String(unix(now) + 1),
    bucket_width: "1d",
    limit: String(PAGE_LIMIT),
  });
  params.append("project_ids", config.projectId);
  params.append("group_by", "project_id");
  const buckets = await fetchAllBuckets("/organization/costs", params, config.adminKey, "costs");

  const today = unix(startOfUtcDay(now));
  let period = 0;
  let todayCost = 0;
  for (const bucket of buckets) {
    for (const r of bucket.results ?? []) {
      if (r.project_id != null && r.project_id !== config.projectId) continue;
      const amount = r.amount as { value?: unknown; currency?: unknown } | undefined;
      if (!amount || amount.value == null) continue;
      if (typeof amount.currency === "string" && amount.currency.toLowerCase() !== "usd") throw new MonitorError("costs_not_usd");
      const value = Number(amount.value);
      if (!Number.isFinite(value)) throw new MonitorError("costs_bad_shape");
      period += value;
      if ((bucket.start_time ?? 0) >= today) todayCost += value;
    }
  }
  return { periodCostUsd: period, todayCostUsd: todayCost };
}

/** Today's Completions usage for the project, for context in the log. Never fails the run. */
export async function fetchUsageToday(config: SpendConfig, now = Date.now()): Promise<MonitorResult["usageToday"]> {
  const params = new URLSearchParams({ start_time: String(unix(startOfUtcDay(now))), bucket_width: "1d", limit: "1" });
  params.append("project_ids", config.projectId);
  try {
    const buckets = await fetchAllBuckets("/organization/usage/completions", params, config.adminKey, "usage");
    const totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
    for (const b of buckets) {
      for (const r of b.results ?? []) {
        totals.requests += Number(r.num_model_requests) || 0;
        totals.inputTokens += Number(r.input_tokens) || 0;
        totals.outputTokens += Number(r.output_tokens) || 0;
      }
    }
    return totals;
  } catch (e) {
    console.warn("[spend-monitor] usage lookup failed", e instanceof MonitorError ? e.message : "unknown");
    return null;
  }
}

/** Log line always; JSON POST to SPEND_ALERT_WEBHOOK_URL too when set. Delivery failures are logged, not thrown. */
export async function deliverAlert(alert: SpendAlert, webhookUrl: string | null): Promise<void> {
  const line = JSON.stringify({ ...alert, at: new Date().toISOString() });
  if (alert.event === "spend.monitor_error") console.error(line);
  else console.warn(line);
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: line,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) console.error("[spend-monitor] alert webhook answered", res.status);
  } catch {
    console.error("[spend-monitor] alert webhook unreachable");
  }
}

/** Identifies a budget period. A new start date or amount is a new period, so its alerts fire again. */
export const budgetPeriodKey = (config: SpendConfig) => `${config.budgetStart.toISOString()}|${config.budgetUsd}`;

/** One monitor run. Returns a summary safe to show the caller (no key, no provider bodies). */
export async function runSpendMonitor(now = Date.now()): Promise<MonitorResult> {
  const cfg = spendConfig();
  if (!cfg.ok) {
    console.info(JSON.stringify({ event: "spend.not_configured", missing: cfg.missing, invalid: cfg.invalid }));
    return { status: "not_configured", missing: cfg.missing, invalid: cfg.invalid };
  }
  const config = cfg.config;
  const state = await prisma.spendState.findUnique({ where: { id: STATE_ID } });

  let costs: { periodCostUsd: number; todayCostUsd: number };
  try {
    costs = await fetchProjectCosts(config, now);
  } catch (e) {
    const error = e instanceof MonitorError ? e.message : "costs_failed";
    await prisma.spendState.upsert({
      where: { id: STATE_ID },
      create: { id: STATE_ID, lastCheckedAt: new Date(now), lastStatus: "error" },
      update: { lastCheckedAt: new Date(now), lastStatus: "error" },
    });
    // Only on the change into error, so a long outage is one alert, not one an hour.
    if (state?.lastStatus !== "error") await deliverAlert({ event: "spend.monitor_error", error }, config.webhookUrl);
    else console.error("[spend-monitor] still failing", error);
    return { status: "error", error };
  }
  const usageToday = await fetchUsageToday(config, now);

  const { periodCostUsd, todayCostUsd } = costs;
  const percentUsed = (periodCostUsd / config.budgetUsd) * 100;
  const period = budgetPeriodKey(config);
  const already = state?.budgetPeriod === period ? state.alertedThresholds : [];
  const crossed = THRESHOLD_PERCENTS.filter((p) => periodCostUsd >= (config.budgetUsd * p) / 100);
  const fresh = crossed.filter((p) => !already.includes(p));

  let tripReason: string | null = null;
  if (percentUsed >= TRIP_PERCENT) tripReason = `budget_${TRIP_PERCENT}_percent`;
  else if (!config.allowCardCharges && now >= config.creditExpiresAt.getTime()) tripReason = "credit_expired";
  const newTrip = Boolean(tripReason) && !state?.tripped;

  const today = utcDay(now);
  const dailyCeilingHit = config.dailyCeilingUsd !== null && todayCostUsd >= config.dailyCeilingUsd;
  const newCeiling = dailyCeilingHit && state?.dailyCapDay !== today;

  // Write the trip before sending anything: a slow webhook must not delay the stop.
  const alerted = [...new Set([...already, ...crossed])].sort((a, b) => a - b);
  const tripped = Boolean(state?.tripped) || Boolean(tripReason);
  const fields = {
    budgetPeriod: period,
    alertedThresholds: alerted,
    lastCheckedAt: new Date(now),
    lastStatus: tripped ? "tripped" : "ok",
    periodCostUsd: roundCents(periodCostUsd),
    todayCostUsd: roundCents(todayCostUsd),
    ...(newTrip ? { tripped: true, trippedAt: new Date(now), tripReason } : {}),
    ...(newCeiling ? { dailyCapDay: today } : {}),
  };
  const row = await prisma.spendState.upsert({
    where: { id: STATE_ID },
    create: { id: STATE_ID, ...fields },
    update: fields,
  });
  rememberSpendTrip({ tripped: row.tripped, dailyCapDay: row.dailyCapDay }, now);

  const figures = {
    projectId: config.projectId,
    periodStart: config.budgetStart.toISOString(),
    budgetUsd: config.budgetUsd,
    costUsd: roundCents(periodCostUsd),
    percentUsed: Math.round(percentUsed * 10) / 10,
  };
  for (const p of fresh) {
    await deliverAlert({ event: "spend.threshold", thresholdPercent: p, thresholdUsd: roundCents((config.budgetUsd * p) / 100), ...figures }, config.webhookUrl);
  }
  if (newTrip) {
    await deliverAlert({ event: "spend.tripped", reason: tripReason, creditExpiresAt: config.creditExpiresAt.toISOString(), ...figures }, config.webhookUrl);
  }
  if (newCeiling) {
    await deliverAlert({ event: "spend.daily_ceiling", day: today, todayCostUsd: roundCents(todayCostUsd), dailyCeilingUsd: config.dailyCeilingUsd, ...figures }, config.webhookUrl);
  }

  const result: MonitorResult = {
    status: row.tripped ? "tripped" : "ok",
    periodCostUsd: figures.costUsd,
    todayCostUsd: roundCents(todayCostUsd),
    budgetUsd: config.budgetUsd,
    percentUsed: figures.percentUsed,
    alerted: fresh,
    tripped: row.tripped,
    tripReason: row.tripReason,
    dailyCeilingHit,
    usageToday,
  };
  console.info(JSON.stringify({ event: "spend.checked", ...result }));
  return result;
}

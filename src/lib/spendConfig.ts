import "server-only";

/**
 * Settings for the OpenAI spend monitor (STR-691). Pure env parsing, no I/O, so the spend guard can use it
 * on every request.
 *
 * The monitor is on only when OPENAI_ADMIN_KEY, OPENAI_PROJECT_ID and SPEND_BUDGET_START are all set (and a
 * database exists to hold its state). Unconfigured, it reports "not_configured" and nothing it would enforce
 * applies, including the credit expiry date, so self-hosted copies without an OpenAI credit are unaffected.
 */

export const DEFAULT_BUDGET_USD = 500;
/** Alert at 50, 75 and 90 percent of the budget; the last one also trips the kill switch. */
export const THRESHOLD_PERCENTS = [50, 75, 90] as const;
export const TRIP_PERCENT = 90;
/** When the OpenAI credit runs out. After this, any new spend is card spend. Start of the day, UTC. */
export const DEFAULT_CREDIT_EXPIRES_AT = "2026-11-29T00:00:00Z";

export interface SpendConfig {
  adminKey: string;
  projectId: string;
  budgetStart: Date;
  budgetUsd: number;
  creditExpiresAt: Date;
  allowCardCharges: boolean;
  dailyCeilingUsd: number | null;
  webhookUrl: string | null;
}

export type SpendConfigResult = { ok: true; config: SpendConfig } | { ok: false; missing: string[]; invalid: string[] };

const env = (name: string) => process.env[name]?.trim() || "";

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parsePositive(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Reads the monitor's settings. Names of missing or invalid variables only, never their values. */
export function spendConfig(): SpendConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const adminKey = env("OPENAI_ADMIN_KEY");
  const projectId = env("OPENAI_PROJECT_ID");
  const startRaw = env("SPEND_BUDGET_START");
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!adminKey) missing.push("OPENAI_ADMIN_KEY");
  if (!projectId) missing.push("OPENAI_PROJECT_ID");
  if (!startRaw) missing.push("SPEND_BUDGET_START");

  const budgetStart = parseDate(startRaw);
  if (startRaw && !budgetStart) invalid.push("SPEND_BUDGET_START");

  const budgetRaw = env("SPEND_BUDGET_USD");
  const budgetUsd = budgetRaw ? parsePositive(budgetRaw) : DEFAULT_BUDGET_USD;
  if (budgetUsd === null) invalid.push("SPEND_BUDGET_USD");

  const expiresRaw = env("SPEND_CREDIT_EXPIRES_AT");
  const creditExpiresAt = parseDate(expiresRaw || DEFAULT_CREDIT_EXPIRES_AT);
  if (!creditExpiresAt) invalid.push("SPEND_CREDIT_EXPIRES_AT");

  const ceilingRaw = env("SPEND_DAILY_CEILING_USD");
  const dailyCeilingUsd = ceilingRaw ? parsePositive(ceilingRaw) : null;
  if (ceilingRaw && dailyCeilingUsd === null) invalid.push("SPEND_DAILY_CEILING_USD");

  const webhookRaw = env("SPEND_ALERT_WEBHOOK_URL");
  let webhookUrl: string | null = null;
  if (webhookRaw) {
    try {
      const u = new URL(webhookRaw);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      webhookUrl = u.toString();
    } catch {
      invalid.push("SPEND_ALERT_WEBHOOK_URL");
    }
  }

  if (missing.length || invalid.length || !budgetStart || budgetUsd === null || !creditExpiresAt) {
    return { ok: false, missing, invalid };
  }
  return {
    ok: true,
    config: {
      adminKey,
      projectId,
      budgetStart,
      budgetUsd,
      creditExpiresAt,
      allowCardCharges: env("SPEND_ALLOW_CARD_CHARGES").toLowerCase() === "true",
      dailyCeilingUsd,
      webhookUrl,
    },
  };
}

/** True when the monitor would run: every required setting is present and valid. */
export function spendMonitorConfigured(): boolean {
  return spendConfig().ok;
}

/**
 * True once the credit has expired on a server running the monitor, unless card charges are allowed.
 * The guard checks this on every request so no paid call starts between expiry and the next hourly run.
 */
export function creditExpiredBlock(now = Date.now()): boolean {
  const result = spendConfig();
  if (!result.ok) return false;
  return !result.config.allowCardCharges && now >= result.config.creditExpiresAt.getTime();
}

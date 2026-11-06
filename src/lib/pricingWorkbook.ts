/**
 * The pricing page "Comparison workbook": plan heads and comparison rows for one billing period. Pure and client-safe.
 * Every number comes from the locked plan constants in pricing.ts. Annual minimum totals are not defined there, so the
 * annual view states the seat minimum and the per-seat price instead of computing a new total.
 */
import { FREE_VOICE_MIN, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT, type Billing } from "@/lib/pricing";

export type PlanId = "free" | "pro" | "team";
export const PLAN_IDS: readonly PlanId[] = ["free", "pro", "team"];

/** Team's smallest monthly bill: the seat price times the seat minimum ($59 x 3 = $177). */
export const TEAM_MIN_MONTHLY_BILL = PRICE.team.month * TEAM_MIN_SEATS;
/** Voice minutes in the smallest Team pool (300 x 3 = 900). */
export const TEAM_MIN_POOL = TEAM_VOICE_MIN_PER_SEAT * TEAM_MIN_SEATS;

export const WORKBOOK_HEADLINE = "Compare Free, Pro and Team.";
export const TEXT_NO_VOICE_NOTE = "Unlimited text practice uses no voice minutes.";
export const TEAM_POOL_LINE = `${TEAM_MIN_SEATS} seats include ${TEAM_MIN_POOL} shared voice minutes a month. Team starts at $${TEAM_MIN_MONTHLY_BILL} a month.`;

/** Plan call-to-action labels when checkout is live. Paid plans never read "Start free". */
export const PLAN_CTA: Record<PlanId, string> = { free: "Start free, no card", pro: "Start Pro", team: "Start with Team" };
/** Paid plan label when checkout is not set up on this server: the link still carries the plan, but sells nothing. */
export const PAID_CTA_BILLING_OFF = "Create account";

export interface PlanHead {
  id: PlanId;
  name: string;
  note: string;
  price: string;
  unit: string;
  /** Shown right under the unit price. Team only. */
  minimum?: string;
  /** Annual saving note on paid plans. */
  saving?: string;
}

export function planHeads(b: Billing): Record<PlanId, PlanHead> {
  const year = b === "year";
  const saving = year ? "2 months free" : undefined;
  return {
    free: { id: "free", name: "Free", note: "No card", price: "$0", unit: "per month" },
    pro: { id: "pro", name: "Pro", note: "For individual reps", price: `$${PRICE.pro[b]}`, unit: year ? "per year" : "per month", saving },
    team: {
      id: "team", name: "Team", note: "For a manager plus reps", price: `$${PRICE.team[b]}`,
      unit: year ? "per seat, per year" : "per seat, per month",
      minimum: year ? `${TEAM_MIN_SEATS}-seat minimum` : `$${TEAM_MIN_MONTHLY_BILL} a month minimum`,
      saving,
    },
  };
}

export interface WorkbookRow {
  id: string;
  label: string;
  cells: Record<PlanId, string>;
}

const all = (v: string): Record<PlanId, string> => ({ free: v, pro: v, team: v });

/** Rows under the price row. The first three are the bill: voice minutes, seat minimum and minimum total bill. */
export function workbookRows(b: Billing): WorkbookRow[] {
  return [
    { id: "voice", label: "Voice minutes", cells: {
      free: `${FREE_VOICE_MIN} a month`,
      pro: `${PRO_VOICE_MIN} a month`,
      team: `${TEAM_VOICE_MIN_PER_SEAT} per seat a month, pooled (${TEAM_MIN_POOL} at ${TEAM_MIN_SEATS} seats)`,
    } },
    { id: "seats", label: "Minimum seats", cells: { free: "1", pro: "1", team: `${TEAM_MIN_SEATS}` } },
    { id: "minimum", label: "Minimum total bill", cells: b === "month"
      ? { free: "$0", pro: `$${PRICE.pro.month} a month`, team: `$${TEAM_MIN_MONTHLY_BILL} a month` }
      : { free: "$0", pro: `$${PRICE.pro.year} a year`, team: `${TEAM_MIN_SEATS} seats at $${PRICE.team.year} a year each` } },
    { id: "text", label: "Text practice", cells: all("Unlimited") },
    { id: "coach", label: "Live coaching", cells: all("Included") },
    { id: "debrief", label: "Graded debriefs with transcript quotes", cells: all("Included") },
    { id: "library", label: "Persona library", cells: { free: "Core", pro: "Full", team: "Full" } },
    { id: "packs", label: "Reviewed persona packs", cells: { free: "Not included", pro: "Coming soon", team: "Coming soon" } },
    { id: "wizard", label: "Persona wizard", cells: { free: "Not included", pro: "Included", team: "Included" } },
    { id: "team", label: "Team view and assignments", cells: { free: "Not included", pro: "Not included", team: "Included" } },
    { id: "mfa", label: "MFA", cells: { free: "Included", pro: "Included", team: "Enforced for the team" } },
    { id: "support", label: "Support", cells: { free: "Community", pro: "Email", team: "Priority email" } },
    { id: "overage", label: "Overage charges", cells: all("None") },
  ];
}

/** The table's accessible name. Unique on the page. */
export const workbookCaption = (b: Billing): string =>
  `Compare Free, Pro and Team plans, ${b === "month" ? "monthly" : "annual"} billing`;

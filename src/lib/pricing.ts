/** Locked plan numbers. Pricing and landing pages render from here so they never drift. */
import { UTM_PARAMS, sanitizeTouchValue } from "@/lib/firstTouch";

/** Must equal FREE_MINUTES in usagePlan (PR #20). Import it here once #20 merges. */
export const FREE_VOICE_MIN = 10;
/** One-line Free plan summary, used on the Free card and in the FAQ. */
export const FREE_SUMMARY = `Free: ${FREE_VOICE_MIN} voice minutes a month, enough for a full graded call, plus unlimited text practice. No card.`;
/** Exact in-app billing copy for how call length is counted. */
export const MINUTES_ROUNDED_NOTE = "Calls are counted in whole minutes, rounded up.";
export const PRO_VOICE_MIN = 200;
export const TEAM_VOICE_MIN_PER_SEAT = 300;
export const TEAM_MIN_SEATS = 3;
export const PREMIUM_VOICE_CAP_PCT = 60;

export const PRICE = {
  pro: { month: 29, year: 290 },
  team: { month: 59, year: 590 },
  premium: { month: 30, year: 300 },
} as const;

export type Billing = "month" | "year";

/**
 * Sign-up link for a CTA. Query params are kept in a fixed order: plan, seg, src, then any utm_* tags
 * found in `pageSearch` (the current page's query string), sanitized like the first-touch cookie.
 */
export function registerHref(params: { plan?: "pro" | "team"; seg?: string; src: string }, pageSearch?: string | URLSearchParams): string {
  const q = new URLSearchParams();
  if (params.plan) q.set("plan", params.plan);
  if (params.seg) q.set("seg", params.seg);
  q.set("src", params.src);
  return withPageUtm(`/register?${q.toString()}`, pageSearch);
}

/** Adds the page's utm_* tags to a /register link that does not carry them yet. Other links are returned as is. */
export function withPageUtm(href: string, pageSearch?: string | URLSearchParams): string {
  if (!pageSearch || !href.startsWith("/register")) return href;
  const page = typeof pageSearch === "string" ? new URLSearchParams(pageSearch) : pageSearch;
  const [path, query = ""] = href.split("?", 2);
  const q = new URLSearchParams(query);
  for (const [param] of UTM_PARAMS) {
    const v = sanitizeTouchValue(page.get(param));
    if (v && !q.has(param)) q.set(param, v);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

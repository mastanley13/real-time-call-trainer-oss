/** Locked plan numbers. Pricing and landing pages render from here so they never drift. */

export const FREE_VOICE_MIN = 20;
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

/** Sign-up link for a CTA. Query params are kept in a fixed order. */
export function registerHref(params: { plan?: "pro" | "team"; seg?: string; src: string }): string {
  const q = new URLSearchParams();
  if (params.plan) q.set("plan", params.plan);
  if (params.seg) q.set("seg", params.seg);
  q.set("src", params.src);
  return `/register?${q.toString()}`;
}

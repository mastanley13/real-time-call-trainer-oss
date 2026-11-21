/**
 * The /try/[role] pages: a cold-email reader tries a text call first, then books a demo. Pure and client-safe.
 * Copy rules: plain, sentence case, no em or en dashes.
 */

export const TRY_ROLE_SLUGS = ["dealership", "real-estate", "staffing", "insurance"] as const;
export type TryRoleSlug = (typeof TRY_ROLE_SLUGS)[number];

export interface TryRole {
  slug: TryRoleSlug;
  /** Short audience line above the headline. */
  eyebrow: string;
  headline: string;
  bullets: [string, string, string];
  /** Library persona id the free practice opens on. Must exist in LIBRARY (tests check). */
  personaId: string;
  title: string;
  description: string;
}

export const TRY_PRIMARY_LABEL = "Start free practice";
export const TRY_DEMO_LABEL = "Book a demo for your team";
export const TRY_NOTE = "Free account, no card. Text practice works right away.";

const COACH = "A live coach on the call.";
const DEBRIEF = "A graded debrief that quotes the transcript.";

export const TRY_ROLES: Record<TryRoleSlug, TryRole> = {
  dealership: {
    slug: "dealership",
    eyebrow: "For dealership BDC and internet sales",
    headline: "Practice an internet-lead callback against an AI buyer who pushes back.",
    bullets: ["An AI buyer who objects and changes the subject.", COACH, DEBRIEF],
    personaId: "auto-inbound-used-crossover-lead",
    title: "Try an internet-lead callback | Call Trainer",
    description: "Practice an internet-lead callback against an AI buyer who pushes back, with a live coach and a graded debrief. Free, no card.",
  },
  "real-estate": {
    slug: "real-estate",
    eyebrow: "For real estate agents and ISAs",
    headline: "Practice a portal-lead callback against an AI buyer who pushes back.",
    bullets: ["An AI buyer inquiring about a listing.", COACH, DEBRIEF],
    personaId: "real-estate-portal-buyer-inquiry",
    title: "Try a portal-lead callback | Call Trainer",
    description: "Practice a portal-lead callback against an AI buyer who pushes back, with a live coach and a graded debrief. Free, no card.",
  },
  staffing: {
    slug: "staffing",
    eyebrow: "For recruiters and staffing teams",
    headline: "Practice a candidate screen against an AI candidate who pushes back.",
    bullets: ["An AI candidate who is evaluating you too.", COACH, DEBRIEF],
    personaId: "recruiting-active-candidate-support-lead",
    title: "Try a candidate screen | Call Trainer",
    description: "Practice a candidate screen against an AI candidate who pushes back, with a live coach and a graded debrief. Free, no card.",
  },
  insurance: {
    slug: "insurance",
    eyebrow: "For insurance agents",
    headline: "Practice an inbound auto quote against an AI buyer who pushes back.",
    bullets: ["An AI buyer shopping a first policy.", COACH, DEBRIEF],
    personaId: "insurance-first-solo-auto-quote",
    title: "Try an inbound auto quote | Call Trainer",
    description: "Practice an inbound auto quote against an AI buyer who pushes back, with a live coach and a graded debrief. Free, no card.",
  },
};

/** The role for a slug, or undefined for anything off the allowlist (including inherited keys like "constructor"). */
export function tryRole(slug: string): TryRole | undefined {
  return (TRY_ROLE_SLUGS as readonly string[]).includes(slug) ? TRY_ROLES[slug as TryRoleSlug] : undefined;
}

/** Bounds so a pasted link cannot grow the hrefs without limit. */
const MAX_UTM_KEYS = 8;
const MAX_UTM_KEY = 40;
const MAX_UTM_VALUE = 120;
/** safeNextPath rejects a next longer than this, so the utm copy inside next is dropped when it would not fit. */
const MAX_NEXT = 200;

/** Every search param whose key starts with "utm_" (case-sensitive), in order, bounded. Others are ignored. */
export function utmParams(q: { forEach(cb: (value: string, key: string) => void): void } | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  q?.forEach((value, key) => {
    if (out.length >= MAX_UTM_KEYS) return;
    if (!key.startsWith("utm_") || key.length > MAX_UTM_KEY || value.length > MAX_UTM_VALUE) return;
    out.push([key, value]);
  });
  return out;
}

const withQuery = (path: string, pairs: [string, string][]) => {
  const qs = new URLSearchParams(pairs).toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
};

/**
 * Where the new account lands: the text call on this role's persona, plus as many utm pairs as fit, in order. A pair
 * that would push next past MAX_NEXT stops the list there; the rest stay on /register itself (tryRegisterHref).
 */
export function tryNextPath(role: TryRole, utm: [string, string][] = []): string {
  const base = `/trainer?${new URLSearchParams({ scenario: role.personaId, mode: "text" })}`;
  const kept: [string, string][] = [];
  for (const pair of utm) {
    if (withQuery(base, [...kept, pair]).length > MAX_NEXT) break;
    kept.push(pair);
  }
  return withQuery(base, kept);
}

/** "Start free practice": /register with the encoded next, and the utm keys on /register itself. */
export function tryRegisterHref(role: TryRole, utm: [string, string][] = []): string {
  return withQuery(`/register?${new URLSearchParams({ next: tryNextPath(role, utm) })}`, utm);
}

/** "Book a demo for your team": /demo (a 307 to the booking widget that keeps the query) with the utm keys. */
export function tryDemoHref(utm: [string, string][] = []): string {
  return withQuery("/demo", utm);
}

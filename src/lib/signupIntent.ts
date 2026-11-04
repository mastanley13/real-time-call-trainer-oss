import { safeNextPath } from "./safeNext";

/**
 * Sign-up intent from the pricing CTAs (/register?plan=pro&interval=year&src=...&seg=...). Pure and client-safe.
 * Only whitelisted keys with validated values survive, so it is safe to put in a cookie, a query string or a path.
 */
export const SIGNUP_INTENT_KEYS = ["plan", "interval", "src", "seg"] as const;
export type SignupIntent = Partial<Record<(typeof SIGNUP_INTENT_KEYS)[number], string>>;

const PLANS = new Set(["pro", "team"]);
const INTERVALS = new Set(["month", "year"]);
const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function parseSignupIntent(get: (key: string) => string | null | undefined): SignupIntent {
  const out: SignupIntent = {};
  const plan = get("plan")?.toLowerCase();
  if (plan && PLANS.has(plan)) out.plan = plan;
  const interval = get("interval")?.toLowerCase();
  if (interval && INTERVALS.has(interval)) out.interval = interval;
  for (const key of ["src", "seg"] as const) {
    const v = get(key);
    if (v && TAG.test(v)) out[key] = v;
  }
  return out;
}

/** Re-validates an intent that came back from a signed cookie or a client object. */
export function cleanSignupIntent(raw: unknown): SignupIntent {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return parseSignupIntent((k) => (typeof obj[k] === "string" ? (obj[k] as string) : null));
}

/** The query string (no leading "?") in a fixed key order, or "" when there is no intent. */
export function signupIntentQuery(intent: SignupIntent): string {
  const q = new URLSearchParams();
  for (const k of SIGNUP_INTENT_KEYS) if (intent[k]) q.set(k, intent[k]!);
  return q.toString();
}

/**
 * Where a finished Google sign-in lands. A brand-new account from /register goes where email signup goes
 * (/trainer) with its whitelisted intent kept in the query. Everyone else goes to the validated next path.
 */
export function googleLandingPath(flow: { next: string; intent?: SignupIntent }, created: boolean): string {
  const qs = created && flow.intent ? signupIntentQuery(cleanSignupIntent(flow.intent)) : "";
  return qs ? safeNextPath(`/trainer?${qs}`) : safeNextPath(flow.next);
}

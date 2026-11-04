import { safeNextPath } from "./safeNext";
import { checkoutStartHref, sanitizeSignupIntent } from "./pricing";

/**
 * Sign-up intent from the pricing CTAs (/register?plan=pro&interval=year&src=...&seg=...). Pure and client-safe.
 * Only whitelisted keys with validated values survive, so it is safe to put in a cookie, a query string or a path.
 * The whitelist itself lives in pricing.ts (sanitizeSignupIntent), shared with POST /api/auth/register.
 */
export const SIGNUP_INTENT_KEYS = ["plan", "interval", "src", "seg"] as const;
export type SignupIntent = Partial<Record<(typeof SIGNUP_INTENT_KEYS)[number], string>>;

export function parseSignupIntent(get: (key: string) => string | null | undefined): SignupIntent {
  return sanitizeSignupIntent({ plan: get("plan")?.toLowerCase(), interval: get("interval"), src: get("src"), seg: get("seg") });
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
 * Where a finished Google sign-in lands. A brand-new account from /register goes where email signup goes: a paid plan
 * to /checkout/start (the page sends Free-only or billing-off cases back to /trainer), anything else to /trainer with
 * its whitelisted intent kept in the query. Everyone else goes to the validated next path.
 */
export function googleLandingPath(flow: { next: string; intent?: SignupIntent }, created: boolean): string {
  const intent = created && flow.intent ? cleanSignupIntent(flow.intent) : {};
  if (intent.plan === "pro" || intent.plan === "team") {
    return safeNextPath(checkoutStartHref(intent.plan, intent.interval === "year" ? "year" : "month"));
  }
  const qs = signupIntentQuery(intent);
  return qs ? safeNextPath(`/trainer?${qs}`) : safeNextPath(flow.next);
}

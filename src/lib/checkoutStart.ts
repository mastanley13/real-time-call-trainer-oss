import { checkoutFailure } from "./billingUi";
import { withFirstRun } from "./firstRun";
import { checkoutStartHref, sanitizeSignupIntent, type Billing, type PlanIntent, type SignupIntent } from "./pricing";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "./usagePlan";

/**
 * The checkout step behind the pricing buttons when billing is on, and where each sign-up or checkout answer lands.
 * Client-safe and pure apart from the injected fetch and storage, so it can be tested without a browser.
 */

export type NoticeKind = "plans_soon" | "paid_soon";

/** One-time notices shown on /trainer. "plans_soon" follows a sign-up from a Pro or Team link while billing is off. */
export const NOTICE_TEXT: Record<NoticeKind, string> = {
  plans_soon: "You're on Free. Pro and Team checkout is not set up on this server.",
  paid_soon: "Checkout is not available right now. You're on Free. Try again later.",
};
/** Query value on /settings/billing for a checkout that found an existing plan. */
export const ALREADY_SUBSCRIBED_NOTICE = "already_subscribed";

export const BILLING_NOTICE_PATH = `/settings/billing?notice=${ALREADY_SUBSCRIBED_NOTICE}`;

/** The subscription statuses a 409 may carry to the billing notice. Anything else is dropped. */
export const NOTICE_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

/** Returns the status only when it is one of the six known values. */
export function noticeStatus(value: unknown): NoticeStatus | undefined {
  return NOTICE_STATUSES.find((s) => s === value);
}

/** The billing settings link for an existing plan, with the allowlisted status when there is one. */
export function billingNoticeHref(status?: unknown): string {
  const s = noticeStatus(status);
  return s ? `${BILLING_NOTICE_PATH}&status=${s}` : BILLING_NOTICE_PATH;
}

const NOTICE_KEY = "ct.notice";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Remembers a notice for the next /trainer visit. Storage can be blocked; then the notice is skipped. */
export function rememberNotice(kind: NoticeKind, store?: Store | null): void {
  try {
    (store ?? sessionStorage).setItem(NOTICE_KEY, kind);
  } catch {
    // Private mode or blocked storage: the notice is a courtesy, not required.
  }
}

/** Reads and clears the remembered notice, so it shows once. */
export function takeNotice(store?: Store | null): NoticeKind | null {
  try {
    const s = store ?? sessionStorage;
    const v = s.getItem(NOTICE_KEY);
    s.removeItem(NOTICE_KEY);
    return v === "plans_soon" || v === "paid_soon" ? v : null;
  } catch {
    return null;
  }
}

/** Reads and whitelists the sign-up link values from a query string. Anything invalid is dropped. */
export function intentFromQuery(q: { get(name: string): string | null }): SignupIntent {
  return sanitizeSignupIntent({ plan: q.get("plan"), interval: q.get("interval"), src: q.get("src"), seg: q.get("seg") });
}

/**
 * Where to go once the user is signed in, from a sign-up or a register link opened while signed in. Billing on with a
 * plan goes to the checkout step. Otherwise /trainer, with the open-soon notice when a plan was asked for. Only an
 * account created just now gets ?firstrun=1 (see firstRun.ts); someone already signed in never does.
 */
export function afterSignin(billingEnabled: boolean, intent: SignupIntent, newAccount = false): { path: string; notice: NoticeKind | null } {
  if (intent.plan && billingEnabled) return { path: checkoutStartHref(intent.plan, intent.interval ?? "month"), notice: null };
  return { path: newAccount ? withFirstRun("/trainer") : "/trainer", notice: intent.plan ? "plans_soon" : null };
}

export interface CheckoutStartInput {
  plan: PlanIntent;
  interval: Billing;
  /** Team only; clamped to the Team range. */
  seats?: number;
}

export type CheckoutStartOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "already_subscribed"; status?: NoticeStatus }
  | { kind: "unavailable" }
  | { kind: "error"; message: string; help: boolean };

/** The POST body. Premium is never sold from these buttons, so it is always false. Team starts at the 3-seat minimum. */
export function checkoutBody(input: CheckoutStartInput): { plan: PlanIntent; interval: Billing; premium: false; seats?: number } {
  if (input.plan !== "team") return { plan: input.plan, interval: input.interval, premium: false };
  const seats = Math.min(TEAM_MAX_SEATS, Math.max(TEAM_MIN_SEATS, Math.floor(input.seats ?? TEAM_MIN_SEATS) || TEAM_MIN_SEATS));
  return { plan: "team", interval: input.interval, premium: false, seats };
}

const isHttps = (u: unknown): u is string => {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Calls POST /api/billing/checkout and maps the answer. 200 with an https url redirects. 409 already_subscribed goes to
 * billing settings. Every other answer falls back to Free with the open-soon notice, never an error page. Only a
 * request that got no answer at all (offline) keeps the page, with a retry.
 */
export async function startCheckout(input: CheckoutStartInput, fetchFn: typeof fetch = fetch): Promise<CheckoutStartOutcome> {
  let res: Response;
  try {
    res = await fetchFn("/api/billing/checkout", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkoutBody(input)),
    });
  } catch {
    return { kind: "error", ...checkoutFailure({ networkError: true }) };
  }
  const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown; message?: unknown; status?: unknown };
  if (res.ok && isHttps(data.url)) return { kind: "redirect", url: data.url };
  if (res.status === 409 && data.error === "already_subscribed") {
    const status = noticeStatus(data.status);
    return status ? { kind: "already_subscribed", status } : { kind: "already_subscribed" };
  }
  // Every other answer (400, 403, 422, 429, 500, 503, a 200 with no usable address) sells nothing: stay on Free.
  return { kind: "unavailable" };
}

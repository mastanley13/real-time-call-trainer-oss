import "server-only";
import { createHmac } from "node:crypto";
import { after } from "next/server";
import { prisma } from "./db";
import { billingEventsEnabled, type BillingEventSink, type BillingLifecycleEvent, type BillingLifecycleKind } from "./billingEvents";
import type { SignupIntent } from "./pricing";
import type { PlanTier } from "./usagePlan";

/**
 * Lifecycle events for the CRM, pushed to one GoHighLevel Inbound Webhook URL. There is no GHL token or API
 * client here: GHL workflows with an Inbound Webhook trigger pick the events up and do the CRM work.
 *
 * Off unless GHL_BILLING_EVENTS=true AND GHL_WEBHOOK_URL is an https URL. Treat the URL as a secret: anyone who
 * has it can post into the workflow, so it is never logged or returned. GHL_WEBHOOK_SECRET is optional: when set,
 * each request carries an HMAC of the body (see signGhlBody) for a relay or a workflow filter to check. GHL's
 * Inbound Webhook trigger does not verify signatures itself, and without the secret the JSON is posted unsigned.
 *
 * Every send is fire and forget with a hard timeout. Nothing here throws and nothing waits on GHL, so a GHL outage
 * can never fail signup, grading or the Stripe webhook. Each payload has a deterministic eventId (also sent as the
 * Idempotency-Key header) so a workflow can drop repeats.
 *
 * Personal data: every event carries the contact's lowercased email (Keel decision) so each GHL workflow can match the
 * contact directly, next to userId and organizationId. Nothing else personal is sent: no names, phone, password,
 * card data, Stripe customer or subscription ids, or raw Stripe objects.
 */

type Env = Record<string, string | undefined>;

/** Hard cap on one POST. A slow GHL is abandoned, never waited on. */
export const GHL_TIMEOUT_MS = 2500;

export type GhlEventType = "signup" | "first_graded_call" | BillingLifecycleKind;

interface GhlBase {
  /** Stable id for dedupe: the same real-world event always has the same id. Also the Idempotency-Key header. */
  eventId: string;
  event: GhlEventType;
  /** ISO 8601 time the app sent the event. */
  occurredAt: string;
  /** Always "calltrainer", so a shared GHL location can filter on it. */
  app: "calltrainer";
  /** Payload format version. */
  version: 1;
}

/** A new account, from email signup or a first Google sign-in. eventId: signup:{userId}. */
export interface GhlSignupPayload extends GhlBase {
  event: "signup";
  /** Calltrainer user id. Store it on the contact (custom field "Calltrainer User ID") to match later events. */
  userId: string;
  organizationId: string | null;
  /** Lowercased. GHL creates or matches the contact by it. */
  email: string;
  signupMethod: "email" | "google";
  /** "owner" for a new team, "trainee" when joining one with an org code. */
  role: "owner" | "trainee";
  /** Plan picked on the pricing page before signup, if any. Not a purchase. */
  planIntent: "pro" | "team" | null;
  billingInterval: "month" | "year" | null;
  /** Whitelisted sign-up link tags (src and seg query params): lowercase a-z, 0-9, _ and -, at most 40 chars. */
  source: string | null;
  segment: string | null;
}

/** The first call of a user's that was saved with a server-sealed grade. eventId: first_graded_call:{userId}. */
export interface GhlFirstGradedCallPayload extends GhlBase {
  event: "first_graded_call";
  userId: string;
  organizationId: string | null;
  /** The user's email, lowercased, for contact matching. */
  email: string;
  /** The saved call (TrainerSession id). */
  sessionId: string;
  /** Persona id the call was practised against. */
  scenarioId: string;
  /** 0 to 100, rounded. */
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

/**
 * A Stripe plan change on a Calltrainer subscription (metadata app=calltrainer), after the plan is applied.
 * eventId: stripe:{stripeRef}:{event}, identical whether the success page or the Stripe webhook applied the change
 * first. Never a raw Stripe object, customer or subscription id, price or card data.
 */
export interface GhlPlanChangePayload extends GhlBase {
  event: BillingLifecycleKind;
  /** Who holds the plan: a user (Pro) or an organization (Team). */
  subject: "user" | "organization";
  subjectId: string;
  /** The user on a user plan; on a Team plan, the user who bought it (from Calltrainer's own checkout metadata), if known. */
  userId: string | null;
  /** Set on a Team plan. */
  organizationId: string | null;
  /**
   * Lowercased contact email, looked up at send time in the background. The user's email on a Pro plan; on a Team
   * plan the buyer's (userId) when that user still exists and is still in the org, else the org owner's (earliest
   * owner row in that org). Null when no such user exists at send time (user deleted, org with no owner row) or the
   * lookup failed or took longer than GHL_TIMEOUT_MS; the event is still sent.
   */
  email: string | null;
  fromPlan: PlanTier;
  toPlan: PlanTier;
  seats: number;
  premiumVoice: boolean;
  /**
   * subscription:{first 32 hex of sha256(Stripe subscription id)}, so both apply paths share one eventId and the raw id
   * is never sent. Rare fallback when no subscription id is known: checkout_session:{id} or the Stripe event id (evt_...).
   */
  stripeRef: string;
}

export type GhlPayload = GhlSignupPayload | GhlFirstGradedCallPayload | GhlPlanChangePayload;

let warnedBadUrl = false;

/** The inbound webhook URL, or null when events are off (flag not "true", URL unset, or not https). */
export function ghlWebhookUrl(env: Env = process.env): string | null {
  if (!billingEventsEnabled(env)) return null;
  const raw = env.GHL_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString();
  } catch {
    // fall through
  }
  if (!warnedBadUrl) {
    warnedBadUrl = true;
    console.warn("[ghl] GHL_WEBHOOK_URL is not a valid https URL; lifecycle events are not sent");
  }
  return null;
}

/** True when lifecycle events will be posted. Callers use it to skip work (such as a database read) when off. */
export const ghlEventsEnabled = (env: Env = process.env): boolean => ghlWebhookUrl(env) !== null;

/** sha256=HMAC-SHA256(secret, "{timestamp}.{body}") in hex, sent as X-Calltrainer-Signature with X-Calltrainer-Timestamp. */
export function signGhlBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const base = <E extends GhlEventType>(eventId: string, event: E, now: Date) =>
  ({ eventId, event, occurredAt: now.toISOString(), app: "calltrainer" as const, version: 1 as const });

export function signupPayload(
  input: { userId: string; organizationId: string | null; email: string; method: "email" | "google"; role: "owner" | "trainee"; intent: SignupIntent },
  now = new Date(),
): GhlSignupPayload {
  return {
    ...base(`signup:${input.userId}`, "signup", now),
    userId: input.userId,
    organizationId: input.organizationId,
    email: input.email.toLowerCase(),
    signupMethod: input.method,
    role: input.role,
    planIntent: input.intent.plan ?? null,
    billingInterval: input.intent.interval ?? null,
    source: input.intent.src ?? null,
    segment: input.intent.seg ?? null,
  };
}

export function firstGradedCallPayload(
  input: { userId: string; organizationId: string | null; email: string; sessionId: string; scenarioId: string; overallScore: number; grade: GhlFirstGradedCallPayload["grade"] },
  now = new Date(),
): GhlFirstGradedCallPayload {
  return {
    ...base(`first_graded_call:${input.userId}`, "first_graded_call", now),
    userId: input.userId,
    organizationId: input.organizationId,
    email: input.email.toLowerCase(),
    sessionId: input.sessionId,
    scenarioId: input.scenarioId,
    overallScore: Math.round(input.overallScore),
    grade: input.grade,
  };
}

export function planChangePayload(e: BillingLifecycleEvent, email: string | null, now = new Date()): GhlPlanChangePayload {
  return {
    ...base(`stripe:${e.stripeRef}:${e.kind}`, e.kind, now),
    subject: e.subject,
    subjectId: e.subjectId,
    userId: e.subject === "user" ? e.subjectId : e.purchaserUserId,
    organizationId: e.subject === "organization" ? e.subjectId : null,
    email: email ? email.toLowerCase() : null,
    fromPlan: e.fromPlan,
    toPlan: e.toPlan,
    seats: e.seats,
    premiumVoice: e.premiumVoice,
    stripeRef: e.stripeRef,
  };
}

/**
 * Posts one payload and resolves when done. Never rejects: a timeout, network error or non-2xx answer is logged
 * with the event type and status only (never the URL, body or GHL's answer).
 */
export async function postGhlEvent(payload: GhlPayload, env: Env = process.env): Promise<void> {
  const url = ghlWebhookUrl(env);
  if (!url) return;
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": payload.eventId,
      "user-agent": "calltrainer-ghl-webhook/1",
    };
    const secret = env.GHL_WEBHOOK_SECRET?.trim();
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers["x-calltrainer-timestamp"] = timestamp;
      headers["x-calltrainer-signature"] = signGhlBody(secret, timestamp, body);
    }
    const res = await fetch(url, { method: "POST", headers, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(GHL_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) console.error(`[ghl] ${payload.event} webhook answered status ${res.status}`);
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    console.error(`[ghl] ${payload.event} webhook ${timedOut ? "timed out" : "failed"}`);
  }
}

const inflight = new Set<Promise<void>>();

/**
 * Schedules a send and returns at once. `build` may be a payload or an async builder that returns null to send
 * nothing; a builder runs in the background too, so a database read it needs never delays the response.
 * Inside a request the work is handed to Next's after() so the platform keeps it alive after the response.
 */
export function emitGhlEvent(build: GhlPayload | (() => Promise<GhlPayload | null>)): void {
  if (!ghlEventsEnabled()) return;
  const work = (async () => {
    try {
      const payload = typeof build === "function" ? await build() : build;
      if (payload) await postGhlEvent(payload);
    } catch {
      console.error("[ghl] lifecycle event could not be built");
    }
  })();
  inflight.add(work);
  void work.finally(() => inflight.delete(work));
  try {
    after(work);
  } catch {
    // Outside a request scope (scripts, tests): the promise already runs on its own and never rejects.
  }
}

/** Waits for every scheduled send. For tests and scripts; request code never waits on GHL. */
export async function settleGhlEvents(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

/** Resolves to null if `work` has not settled within `ms`. */
const within = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

/**
 * The contact email for a plan change: the user on a Pro plan; on a Team plan the buyer if that user still exists and
 * still belongs to the Team org (a buyer who left the team is skipped), else the org's earliest owner. One or two small
 * selects. Null when nobody matches, the read fails, or it takes longer than GHL_TIMEOUT_MS. Never throws.
 */
export async function planChangeEmail(e: BillingLifecycleEvent): Promise<string | null> {
  try {
    return await within((async () => {
      const userId = e.subject === "user" ? e.subjectId : e.purchaserUserId;
      if (userId) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, organizationId: true } });
        const inScope = e.subject === "user" || user?.organizationId === e.subjectId;
        if (user?.email && inScope) return user.email;
      }
      if (e.subject !== "organization") return null;
      const [owner] = await prisma.user.findMany({
        where: { organizationId: e.subjectId, role: "owner" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { email: true },
      });
      return owner?.email ?? null;
    })(), GHL_TIMEOUT_MS);
  } catch {
    console.error(`[ghl] ${e.kind} contact email lookup failed; sending without email`);
    return null;
  }
}

/**
 * The billingEvents sink: plan changes go out through the same POST path. Registered once, in billing.ts. The email
 * lookup runs inside the background work, so the Stripe webhook never waits on it.
 */
export const ghlBillingSink: BillingEventSink = (event) => {
  emitGhlEvent(async () => planChangePayload(event, await planChangeEmail(event)));
};

export function notifySignup(input: Parameters<typeof signupPayload>[0]): void {
  if (!ghlEventsEnabled()) return;
  emitGhlEvent(signupPayload(input));
}

/**
 * Sends first_graded_call when `sessionId` is the user's earliest graded call. The check runs in the background.
 * If two first calls are saved at once, both may send; they share eventId first_graded_call:{userId}, so GHL drops the repeat.
 */
export function notifyIfFirstGradedCall(
  input: Parameters<typeof firstGradedCallPayload>[0],
  earliestGradedSessionId: (userId: string) => Promise<string | null>,
): void {
  if (!ghlEventsEnabled()) return;
  emitGhlEvent(async () => ((await earliestGradedSessionId(input.userId)) === input.sessionId ? firstGradedCallPayload(input) : null));
}

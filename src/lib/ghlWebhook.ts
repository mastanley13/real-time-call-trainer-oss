import "server-only";
import { createHmac } from "node:crypto";
import { after } from "next/server";
import { prisma } from "./db";
import { billingEventsEnabled, type BillingEventSink, type BillingLifecycleEvent, type BillingLifecycleKind, type PremiumEventSink } from "./billingEvents";
import type { SignupIntent } from "./pricing";
import { billingActive } from "./serverConfig";
import { storedPlanEntitled } from "./subscriptionStatus";
import { effectivePlan, type PlanTier } from "./usagePlan";

/**
 * Lifecycle events for the CRM, pushed to one GoHighLevel Inbound Webhook URL. There is no GHL token or API
 * client here: GHL workflows with an Inbound Webhook trigger pick the events up and do the CRM work.
 *
 * Off unless GHL_BILLING_EVENTS=true AND GHL_WEBHOOK_URL is an https URL. Treat the URL as a secret: anyone who
 * has it can post into the workflow, so it is never logged or returned. GHL_WEBHOOK_SECRET is optional: when set,
 * each request carries an HMAC of the body (see signGhlBody) for a relay or a workflow filter to check. GHL's
 * Inbound Webhook trigger does not verify signatures itself, and without the secret the JSON is posted unsigned.
 *
 * Every send is fire and forget with a hard timeout (GHL_TIMEOUT_MS). Nothing exported here throws, synchronously or
 * later, and nothing waits on GHL, so a GHL outage can never fail signup, grading or the Stripe webhook. Each payload has
 * a deterministic eventId (also sent as the Idempotency-Key header) so a workflow can drop repeats.
 *
 * Attempts: signup, plan changes and voice_cap_hit get one POST. first_graded_call (ct-activated) gets at most one retry
 * of the same POST (same body, eventId and Idempotency-Key), inside the same background work, after GHL_RETRY_DELAY_MS
 * and with its own GHL_TIMEOUT_MS bound, and only when the first attempt clearly did not deliver: a connection refused,
 * DNS failure or unreachable network before any response (cause.code ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ENETUNREACH or
 * EHOSTUNREACH), or HTTP 429, 502, 503 or 504. Never after any timeout, including a connect timeout
 * (UND_ERR_CONNECT_TIMEOUT), because GHL may have accepted the request; never after a 500, another 4xx or a 2xx. The
 * retry repeats only the POST: claimFirstGradedCall runs once and its marker is written once.
 *
 * Tags: every payload carries `tags: string[]` so the GHL workflow can apply them to the contact as they are. The one
 * mapping is ghlTagsFor below:
 * - signup:            ct-signed-up, app-calltrainer, then ct-signup-email or ct-signup-google (by signupMethod)
 * - first_graded_call: ct-activated, app-calltrainer
 * - upgrade, downgrade, churn (by toPlan, the plan the subscription moved to):
 *     pro  -> ct-paid-pro, app-calltrainer   (also a Team to Pro downgrade)
 *     team -> ct-paid-team, app-calltrainer
 *     free -> ct-churned, app-calltrainer
 * - voice_cap_hit:     app-calltrainer only (no event tag; the workflow branches on `event` and `reason`)
 * There is no trial tag: a trialing subscription is not tagged differently, and no trial event exists.
 *
 * Personal data: every event carries the contact's lowercased email (Keel decision) so each GHL workflow can match the
 * contact directly, next to userId and organizationId. Nothing else personal is sent: no names, phone, password,
 * card data, Stripe customer or subscription ids, or raw Stripe objects.
 */

type Env = Record<string, string | undefined>;

/** Hard cap on one POST. A slow GHL is abandoned, never waited on. */
export const GHL_TIMEOUT_MS = 2500;

export type GhlEventType = "signup" | "first_graded_call" | "voice_cap_hit" | BillingLifecycleKind;

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
  /** Contact tags for the GHL workflow to apply as they are. Always from ghlTagsFor. */
  tags: string[];
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

/**
 * The user's first graded call (their earliest session with a stored score), sent once per user after a grade is stored
 * by either path: a save with a server-sealed grade (POST /api/transcripts) or the first AI grade of a saved call (PATCH
 * /api/transcripts/[id]). See claimFirstGradedCall. eventId: first_graded_call:{userId}.
 */
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
 * A Stripe plan change on a Calltrainer subscription (see lifecycleEventFor in billing.ts), after the plan is applied.
 * eventId: stripe:{stripeRef}:{event}:{transition}, where transition is a UUID made in the transaction that applied the
 * change. Each transition is emitted once, by the one path that applied it (success page or Stripe webhook), and a later
 * transition on the same subscription (an upgrade after a churn) gets a new id. The payload is built once, so the send
 * and its Idempotency-Key always carry that id. Never a raw Stripe object, customer or subscription id, price or card data.
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
   * subscription:{first 32 hex of sha256(Stripe subscription id)}, the same on every apply path, and the raw id is never
   * sent. Rare fallback when no subscription id is known: checkout_session:{id} or the Stripe event id (evt_...).
   */
  stripeRef: string;
}

/** Why the voice allowance counted as used up: a refused start at a mint route, or a running call the heartbeat stopped. */
export type VoiceCapHitReason = "cap_reached" | "cap_reached_in_call";

/**
 * The voice minute allowance is used up (the voice_cap_hit premium event, see src/lib/premiumEventTypes.ts). A refused
 * start can be retried many times and every member of a team can hit the same pool, so eventId is
 * voice_cap_hit:{organizationId}:{UTC date of the cap hit} (voice_cap_hit:user:{userId}:{date} only for a user with no
 * organization), whatever the reason. The date is the same as occurredAt (both from the time the event was queued, not
 * when it is sent). claimVoiceCapHit drops every repeat of an eventId in the app before anything is posted, so at most
 * one is sent per organization and UTC day. Never a transcript, call or session id, model or provider detail.
 */
export interface GhlVoiceCapHitPayload extends GhlBase {
  event: "voice_cap_hit";
  userId: string;
  organizationId: string | null;
  /**
   * Lowercased contact email, looked up at send time in the background like a plan change's. Null when the user no longer
   * exists, or the lookup failed or took longer than GHL_TIMEOUT_MS; the event is still sent.
   */
  email: string | null;
  /** The plan whose allowance ran out (Team for a pooled member), from stored fields at send time. Null when unknown. */
  plan: PlanTier | null;
  reason: VoiceCapHitReason;
}

export type GhlPayload = GhlSignupPayload | GhlFirstGradedCallPayload | GhlPlanChangePayload | GhlVoiceCapHitPayload;

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

/** On every payload, so a shared GHL location can tell Calltrainer contacts apart. */
export const GHL_APP_TAG = "app-calltrainer";

/** What ghlTagsFor reads: the event, plus signupMethod for signup and toPlan for a plan change. A full payload fits. */
export type GhlTagInput =
  | Pick<GhlSignupPayload, "event" | "signupMethod">
  | Pick<GhlFirstGradedCallPayload, "event">
  | Pick<GhlVoiceCapHitPayload, "event">
  | Pick<GhlPlanChangePayload, "event" | "toPlan">;

const PLAN_TAG: Record<PlanTier, string> = { pro: "ct-paid-pro", team: "ct-paid-team", free: "ct-churned" };

/**
 * The contact tags for one event (the table is in the file header). Pure. A plan change is tagged by the plan it moved
 * to, so a Team to Pro downgrade gets ct-paid-pro and any move to Free gets ct-churned. Never a trial tag.
 */
export function ghlTagsFor(p: GhlTagInput): string[] {
  switch (p.event) {
    case "signup":
      return ["ct-signed-up", GHL_APP_TAG, p.signupMethod === "google" ? "ct-signup-google" : "ct-signup-email"];
    case "first_graded_call":
      return ["ct-activated", GHL_APP_TAG];
    case "voice_cap_hit":
      return [GHL_APP_TAG];
    default:
      return [PLAN_TAG[p.toPlan], GHL_APP_TAG];
  }
}

const base = <E extends GhlEventType>(eventId: string, event: E, now: Date) =>
  ({ eventId, event, occurredAt: now.toISOString(), app: "calltrainer" as const, version: 1 as const });

export function signupPayload(
  input: { userId: string; organizationId: string | null; email: string; method: "email" | "google"; role: "owner" | "trainee"; intent: SignupIntent },
  now = new Date(),
): GhlSignupPayload {
  return {
    ...base(`signup:${input.userId}`, "signup", now),
    tags: ghlTagsFor({ event: "signup", signupMethod: input.method }),
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
    tags: ghlTagsFor({ event: "first_graded_call" }),
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
    ...base(`stripe:${e.stripeRef}:${e.kind}:${e.transition}`, e.kind, now),
    tags: ghlTagsFor({ event: e.kind, toPlan: e.toPlan }),
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
 * The dedupe key of a voice cap hit: one per organization and UTC day of `now`, for any reason and any member. A user
 * with no organization is keyed on the user instead (the "user:" prefix keeps the two id spaces apart).
 */
export function voiceCapHitEventId(input: { userId: string; organizationId: string | null }, now: Date): string {
  return `voice_cap_hit:${input.organizationId ?? `user:${input.userId}`}:${now.toISOString().slice(0, 10)}`;
}

export function voiceCapHitPayload(
  input: { userId: string; organizationId: string | null; email: string | null; plan: PlanTier | null; reason: VoiceCapHitReason },
  now = new Date(),
): GhlVoiceCapHitPayload {
  return {
    ...base(voiceCapHitEventId(input, now), "voice_cap_hit", now),
    tags: ghlTagsFor({ event: "voice_cap_hit" }),
    userId: input.userId,
    organizationId: input.organizationId,
    email: input.email ? input.email.toLowerCase() : null,
    plan: input.plan,
    reason: input.reason,
  };
}

/** Wait before the one retry of a first_graded_call POST (see postGhlEvent). */
export const GHL_RETRY_DELAY_MS = 500;

/** Events whose POST gets one retry when the first attempt clearly did not deliver. Only ct-activated. */
const RETRY_ONCE: ReadonlySet<GhlEventType> = new Set<GhlEventType>(["first_graded_call"]);

/** Answers that mean GHL (or its edge) did not take the request: rate limited, bad gateway, unavailable, gateway timeout. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Connection-phase failures: the request never reached a server, so it cannot have been accepted. Read from the
 * structured `cause.code` of fetch's TypeError, never from message text. A reset or socket error after the request
 * was sent is not here, because GHL may already have run the workflow. No timeout of any kind is here either, not even a
 * connect timeout (UND_ERR_CONNECT_TIMEOUT): a timeout is never retried.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** "delivered" (2xx), "retryable" (clearly not delivered), or "final" (anything else, including a timeout). */
type GhlAttempt = "delivered" | "retryable" | "final";

const notSentError = (e: unknown): boolean => {
  if (!(e instanceof TypeError)) return false;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && NOT_SENT_CODES.has(code);
};

/**
 * Posts one payload and resolves when done. Never rejects: a timeout, network error or non-2xx answer is logged
 * with the event type and status only (never the URL, body or GHL's answer).
 *
 * first_graded_call only: when the first attempt clearly did not deliver (a connection-phase network error before any
 * response, see NOT_SENT_CODES, or HTTP 429, 502, 503 or 504), the same body and headers (same eventId and
 * Idempotency-Key) are posted once more after GHL_RETRY_DELAY_MS, with their own GHL_TIMEOUT_MS bound. Never on any
 * timeout, connect timeout included, a 500, another 4xx or 2xx. This only repeats the POST; the claim and its marker are
 * never touched again. Other events (signup, plan changes, voice_cap_hit) get one attempt.
 */
export async function postGhlEvent(payload: GhlPayload, env: Env = process.env): Promise<void> {
  const url = ghlWebhookUrl(env);
  if (!url) return;
  let init: RequestInit;
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
    init = { method: "POST", headers, body, redirect: "error", cache: "no-store" };
  } catch {
    console.error(`[ghl] ${payload.event} webhook failed`);
    return;
  }
  const attempt = async (label: string): Promise<GhlAttempt> => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GHL_TIMEOUT_MS) });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return "delivered";
      console.error(`[ghl] ${payload.event} ${label} answered status ${res.status}`);
      return RETRY_STATUSES.has(res.status) ? "retryable" : "final";
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      console.error(`[ghl] ${payload.event} ${label} ${timedOut ? "timed out" : "failed"}`);
      return !timedOut && notSentError(e) ? "retryable" : "final";
    }
  };
  if ((await attempt("webhook")) !== "retryable" || !RETRY_ONCE.has(payload.event)) return;
  await new Promise((resolve) => setTimeout(resolve, GHL_RETRY_DELAY_MS));
  if ((await attempt("webhook retry")) === "delivered") console.info(`[ghl] ${payload.event} webhook retry delivered`);
}

const inflight = new Set<Promise<void>>();

/**
 * Schedules a send and returns at once. `build` may be a payload or an async builder that returns null to send
 * nothing; a builder runs in the background too, so a database read it needs never delays the response.
 * Inside a request the work is handed to Next's after() so the platform keeps it alive after the response.
 * Never throws synchronously: the whole body is guarded, so a caller on the signup path cannot be failed by it.
 */
export function emitGhlEvent(build: GhlPayload | (() => Promise<GhlPayload | null>)): void {
  try {
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
  } catch {
    console.error("[ghl] lifecycle event could not be scheduled");
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

/**
 * Contact details for a voice cap hit: the user's email and organization, and their plan by the same rule as
 * resolveAllowance in usage.ts (Team while the org's Team plan is entitled, else the user's own entitled plan). One
 * read-only select, nothing written. Null when the user is gone, the read fails, or it takes longer than GHL_TIMEOUT_MS.
 * Never throws.
 */
export async function voiceCapHitContact(userId: string, now = new Date()): Promise<{ email: string; organizationId: string | null; plan: PlanTier } | null> {
  try {
    return await within((async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true, organizationId: true, planTier: true, subscriptionStatus: true, stripeSubscriptionId: true, pastDueSince: true,
          organization: { select: { planTier: true, subscriptionStatus: true, stripeSubscriptionId: true, pastDueSince: true } },
        },
      });
      if (!user) return null;
      const billingOn = billingActive();
      const org = user.organization;
      const plan: PlanTier = org?.planTier === "team" && storedPlanEntitled(org, now) && billingOn
        ? "team"
        : effectivePlan(storedPlanEntitled(user, now) ? user.planTier : "free", billingOn);
      return { email: user.email, organizationId: user.organizationId, plan };
    })(), GHL_TIMEOUT_MS);
  } catch {
    console.error("[ghl] voice_cap_hit contact lookup failed; sending without email");
    return null;
  }
}

const CAP_HIT_REASONS: ReadonlySet<string> = new Set<VoiceCapHitReason>(["cap_reached", "cap_reached_in_call"]);

/** Namespaces the per-eventId advisory lock taken by claimVoiceCapHit. */
export const VOICE_CAP_HIT_LOCK_PREFIX = "ct-voice-cap-hit:";

/** AuditEvent action of the durable marker: voice_cap_hit was claimed for this eventId (resource = the eventId). */
export const VOICE_CAP_HIT_MARKER = "ghl.voice_cap_hit_sent";

/**
 * Claims the one voice_cap_hit send for an organization and UTC day. One small transaction:
 * 1. reads the user's organizationId (from the database, so the key never depends on the slower contact lookup);
 * 2. builds the eventId (voiceCapHitEventId) and takes pg_advisory_xact_lock on hashtext('ct-voice-cap-hit:' || eventId),
 *    held until commit, so claims for one organization and day run one after the other, across users and instances;
 * 3. if an AuditEvent marker (VOICE_CAP_HIT_MARKER, resource = eventId) exists, returns null: nothing is sent;
 * 4. otherwise inserts the marker and returns the organizationId the key was built from.
 * The lock plus the marker give exactly one claimer per eventId, by commit order, whichever reason or member came first.
 * The marker commits before the POST and is never claimed again, so a send that fails is not repeated (one attempt, as
 * before). A failed claim logs and returns null: at most once wins over at least once. Only called while events are on.
 */
export async function claimVoiceCapHit(userId: string, reason: VoiceCapHitReason, now: Date): Promise<{ eventId: string; organizationId: string | null } | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
      const organizationId = user?.organizationId ?? null;
      const eventId = voiceCapHitEventId({ userId, organizationId }, now);
      // SELECT ... FROM the function, so the result column is an int Prisma can read, not void.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${VOICE_CAP_HIT_LOCK_PREFIX + eventId}::text))`;
      if (await tx.auditEvent.findFirst({ where: { action: VOICE_CAP_HIT_MARKER, resource: eventId }, select: { id: true } })) return null;
      // A user deleted since the cap hit keeps no foreign key on the marker; the eventId still names them.
      await tx.auditEvent.create({ data: { userId: user ? userId : null, action: VOICE_CAP_HIT_MARKER, resource: eventId, metadata: { eventId, reason } } });
      return { eventId, organizationId };
    });
  } catch {
    console.error("[ghl] voice_cap_hit claim failed; not sent");
    return null;
  }
}

/**
 * The premium event sink: forwards voice_cap_hit (subject user, a known reason) to the GHL emitter and ignores every
 * other premium event. Registered once, in billing.ts. queuePremiumEvent already calls it from after(), once the
 * response is sent; emitGhlEvent then hands the claim, lookup and POST to a nested after() (supported by Next.js, the
 * request stays alive until that queue is idle), so nothing here runs before the response. A no-op while GHL events are
 * off (no marker is written then). Only the first cap hit of an organization's UTC day is sent (claimVoiceCapHit).
 */
export const ghlPremiumSink: PremiumEventSink = (event) => {
  if (event.name !== "voice_cap_hit" || event.subject !== "user" || !event.subjectId || !CAP_HIT_REASONS.has(event.reason ?? "")) return;
  const userId = event.subjectId;
  const reason = event.reason as VoiceCapHitReason;
  // The time of the cap hit, stamped when it was queued (queuePremiumEvent), drives occurredAt and the dedupe date.
  // An event with no valid stamp falls back to the time the sink was called.
  const stamped = event.occurredAt ? new Date(event.occurredAt) : null;
  const now = stamped && !Number.isNaN(stamped.getTime()) ? stamped : new Date();
  emitGhlEvent(async () => {
    const claim = await claimVoiceCapHit(userId, reason, now);
    if (!claim) return null;
    const contact = await voiceCapHitContact(userId, now);
    // organizationId from the claim, so the payload's eventId is the one that was claimed.
    return voiceCapHitPayload({ userId, organizationId: claim.organizationId, email: contact?.email ?? null, plan: contact?.plan ?? null, reason }, now);
  });
};

/**
 * Sends signup for a committed new account. Returns at once and never throws: the payload is built inside the
 * background work, so even malformed input only logs. Sign-up responds the same whether GHL is off, down or hung.
 */
export function notifySignup(input: Parameters<typeof signupPayload>[0]): void {
  emitGhlEvent(async () => signupPayload(input));
}

/** Namespaces the per-user advisory lock taken by claimFirstGradedCall. */
export const FIRST_GRADE_LOCK_PREFIX = "ct-first-grade:";

/** AuditEvent action of the durable marker: first_graded_call was claimed for this user (one row per user, ever). */
export const FIRST_GRADED_MARKER = "ghl.first_graded_call_sent";

const GRADES = new Set(["A", "B", "C", "D", "F"]);

/**
 * Decides, after the fact, whether first_graded_call still has to be sent for this user, and claims it. One small
 * transaction, separate from every grade write:
 * 1. pg_advisory_xact_lock on hashtext('ct-first-grade:' || userId), held until commit, so claims for one user run one
 *    after the other;
 * 2. if an AuditEvent marker (FIRST_GRADED_MARKER) exists for the user, nothing is sent;
 * 3. otherwise the user's earliest graded session (overallScore set; oldest createdAt, then id) is the first graded call,
 *    the marker is inserted (resource = that session) and the payload is returned for sending after commit.
 * The lock plus the marker make exactly one claimer ever, by commit order, whichever grade write triggered it. Null when
 * events are off (no marker is written, so the event can still go out once GHL is configured), when the marker exists,
 * or when the user has no graded session. The claim is at most once: the marker commits before the POST and is never
 * written or claimed again. postGhlEvent may repeat the POST of this same payload once when the first attempt clearly did
 * not deliver (see the file header); a timeout or any other failure is not retried, and the marker stays either way.
 *
 * Rollout: users graded before this shipped have no marker, so their next graded call sends one first_graded_call (same
 * eventId first_graded_call:{userId}, ct-activated tag) naming their earliest graded session.
 */
export async function claimFirstGradedCall(userId: string, now = new Date()): Promise<GhlFirstGradedCallPayload | null> {
  if (!ghlEventsEnabled()) return null;
  return prisma.$transaction(async (tx) => {
    // SELECT ... FROM the function, so the result column is an int Prisma can read, not void.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${FIRST_GRADE_LOCK_PREFIX + userId}::text))`;
    if (await tx.auditEvent.findFirst({ where: { userId, action: FIRST_GRADED_MARKER }, select: { id: true } })) return null;
    const first = await tx.trainerSession.findFirst({
      where: { userId, overallScore: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, organizationId: true, scenarioId: true, overallScore: true, grade: true, user: { select: { email: true } } },
    });
    if (!first || first.overallScore === null || !first.grade || !GRADES.has(first.grade) || !first.user?.email) return null;
    const payload = firstGradedCallPayload({
      userId, organizationId: first.organizationId, email: first.user.email, sessionId: first.id, scenarioId: first.scenarioId,
      overallScore: first.overallScore, grade: first.grade as GhlFirstGradedCallPayload["grade"],
    }, now);
    await tx.auditEvent.create({ data: { userId, action: FIRST_GRADED_MARKER, resource: first.id, metadata: { eventId: payload.eventId } } });
    return payload;
  });
}

/**
 * Call after any successful grade write (a sealed grade saved by POST /api/transcripts, or a call going from no score to
 * a score in PATCH /api/transcripts/[id]). Schedules claimFirstGradedCall and the send in the background and returns at
 * once; never throws and never delays the request. Does nothing while events are off.
 */
export function notifyFirstGradedCall(userId: string): void {
  emitGhlEvent(() => claimFirstGradedCall(userId));
}

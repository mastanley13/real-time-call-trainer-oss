import "server-only";
import { after } from "next/server";
import { ghlEnabled } from "./client";
import { drainGhlOutbox, enqueueGhlEvent } from "./outbox";
import { ghlLog } from "./log";
import { GHL_SEGMENTS, type GhlEvent, type GhlPayload, type GhlSegment } from "./types";

const DAY_MS = 86_400_000;
export const ACTIVE_WINDOW_DAYS = 7;
export const QUIET_AFTER_DAYS = 7;
/** Length of the free trial. Used for the "trial ended unpaid" went_quiet rule. */
export const TRIAL_DAYS = 14;
/** Monthly voice minute caps by plan, as reported to GHL. */
export const MINUTE_CAPS: Record<string, number> = { free: 20, pro: 300, team: 1000 };
export const minuteCapFor = (plan: string) => MINUTE_CAPS[plan] ?? MINUTE_CAPS.free;
/** Users read per page by the quiet scan, and a ceiling on pages so one cron run stays bounded. */
export const SCAN_PAGE_SIZE = 500;
export const SCAN_MAX_PAGES = 40;

// ---- Pure decisions (unit tested) ----

/**
 * Which event a newly stored graded call triggers, if any. Paid and post-trial users never move back.
 * `ordinal` is this call's position among the user's graded calls (1 = the first), worked out from the
 * calls saved before it, not from the running total, so concurrent saves each get their own milestone.
 */
export function classifyGradedCall(i: { ordinal: number; createdAt: Date; now: Date; plan: string; wasQuiet: boolean }): GhlEvent | null {
  if (i.plan !== "free") return null;
  const age = i.now.getTime() - i.createdAt.getTime();
  if (i.ordinal <= 1) return "first_graded_call";
  if (age > TRIAL_DAYS * DAY_MS) return null;
  if (i.wasQuiet) return "active_trial";
  if (i.ordinal === 2 && age <= ACTIVE_WINDOW_DAYS * DAY_MS) return "active_trial";
  return null;
}

/** Free users with no call for 7 days, or whose trial ended unpaid. */
export function isWentQuiet(i: { createdAt: Date; lastActive: Date; now: Date; plan: string }): boolean {
  if (i.plan !== "free") return false;
  const trialEnded = i.now.getTime() - i.createdAt.getTime() > TRIAL_DAYS * DAY_MS;
  return trialEnded || i.now.getTime() - i.lastActive.getTime() > QUIET_AFTER_DAYS * DAY_MS;
}

/** Only a segment the user confirmed. Anything else, including unknown strings, becomes null. */
export const confirmedSegment = (s: string | null | undefined): GhlSegment | null => ((GHL_SEGMENTS as readonly string[]).includes(s ?? "") ? (s as GhlSegment) : null);

// ---- Running work without delaying the caller ----

/** Runs after the response when inside a request, otherwise detached. Never throws, never awaited by callers. */
export function runAfterResponse(task: () => Promise<unknown>): void {
  const safe = () => task().catch(() => ghlLog("error", "task_failed"));
  try {
    after(safe);
  } catch {
    void safe();
  }
}

// ---- Payload building ----

type Extra = Partial<GhlPayload> & { occurredAt?: string };
type PayloadUser = { id: string; email: string; firstName: string | null };

function makePayload(user: PayloadUser, event: GhlEvent, plan: string, voiceSeconds: number, extra: Extra = {}): GhlPayload {
  return {
    event,
    occurredAt: extra.occurredAt ?? new Date().toISOString(),
    user: { id: user.id, email: user.email, firstName: user.firstName ?? "" },
    plan,
    segment: extra.segment ?? null,
    minuteCap: extra.minuteCap ?? minuteCapFor(plan),
    voiceMinutesUsed: event === "signup" ? 0 : Math.round((voiceSeconds / 60) * 10) / 10,
    source: extra.source ?? null,
    referredByPartner: extra.referredByPartner ?? null,
    stripeCustomerId: extra.stripeCustomerId ?? null,
  };
}

async function loadUser(userId: string) {
  const { prisma } = await import("@/lib/db");
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, createdAt: true, organization: { select: { planTier: true } } },
  });
}

async function buildPayload(userId: string, event: GhlEvent, extra: Extra = {}): Promise<GhlPayload | null> {
  const user = await loadUser(userId);
  if (!user) return null;
  const { prisma } = await import("@/lib/db");
  const agg = await prisma.trainerSession.aggregate({ where: { userId }, _sum: { durationSeconds: true } });
  return makePayload(user, event, extra.plan ?? user.organization?.planTier ?? "free", agg._sum.durationSeconds ?? 0, extra);
}

async function enqueueFor(userId: string, event: GhlEvent, extra?: Extra) {
  const payload = await buildPayload(userId, event, extra);
  if (payload) await enqueueGhlEvent(payload);
}

/** Enqueue, then try to deliver now. The cron drains whatever this leaves behind. */
const enqueueAndDrain = async (enqueue: () => Promise<unknown>) => {
  await enqueue();
  await drainGhlOutbox();
};

// ---- Emitters. All return immediately; a GHL failure can never reach the caller. ----

export type SignupExtras = { segment?: string | null; source?: string | null; referredByPartner?: string | null };

/** Queue signup (no delivery). Exported for tests; the app calls `emitSignup`. */
export const enqueueSignup = (userId: string, extras: SignupExtras = {}) => enqueueFor(userId, "signup", { ...extras, segment: confirmedSegment(extras.segment) });

/** Account created. `segment` must be a user-confirmed industry; it is never inferred. */
export function emitSignup(userId: string, extras: SignupExtras = {}): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => enqueueAndDrain(() => enqueueSignup(userId, extras)));
}

export type GradedSession = { id: string; createdAt: Date };

/**
 * Queue the milestone for one stored graded call, if it has one. The call's ordinal is the number of
 * graded calls ordered before it (by createdAt, then id) plus one, so two sessions saved before either
 * callback runs still get ordinals 1 and 2, whichever callback runs first. Exported for tests.
 */
export async function enqueueGradedCall(userId: string, session: GradedSession): Promise<GhlEvent | null> {
  const { prisma } = await import("@/lib/db");
  const user = await loadUser(userId);
  if (!user) return null;
  const before = {
    userId,
    overallScore: { not: null },
    OR: [{ createdAt: { lt: session.createdAt } }, { createdAt: session.createdAt, id: { lt: session.id } }],
  };
  const priorCount = await prisma.trainerSession.count({ where: before });
  const prev = await prisma.trainerSession.findFirst({ where: before, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const quiet = await prisma.ghlOutbox.findFirst({ where: { userId, event: "went_quiet" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const event = classifyGradedCall({
    ordinal: priorCount + 1,
    createdAt: user.createdAt,
    now: session.createdAt,
    plan: user.organization?.planTier ?? "free",
    wasQuiet: !!quiet && (!prev || quiet.createdAt > prev.createdAt),
  });
  if (event) await enqueueFor(userId, event, { occurredAt: session.createdAt.toISOString() });
  return event;
}

/** A graded call was stored. Decides between first_graded_call and active_trial. */
export function emitGradedCall(userId: string, session: GradedSession): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => enqueueAndDrain(() => enqueueGradedCall(userId, session)));
}

export type UpgradeInput = { userId: string; plan: "pro" | "team"; stripeCustomerId: string; minuteCap?: number; occurredAt?: string };

/**
 * Paid upgrade. Call this from the Stripe handler for checkout.session.completed and for
 * customer.subscription.updated when the subscription is paid. There is no Stripe code yet.
 */
export function emitUpgrade(input: UpgradeInput): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() =>
    enqueueAndDrain(() =>
      enqueueFor(input.userId, "upgrade", { plan: input.plan, stripeCustomerId: input.stripeCustomerId, minuteCap: input.minuteCap ?? minuteCapFor(input.plan), occurredAt: input.occurredAt }),
    ),
  );
}

/**
 * Daily scan: queue went_quiet for free users who stopped calling or whose trial ended. Walks every
 * candidate page by page (id cursor), so a backlog over one page never starves later users, and skips
 * users already queued for the current quiet spell. Returns how many were queued.
 */
export async function scanWentQuiet(now: Date = new Date()): Promise<number> {
  if (!ghlEnabled()) return 0;
  const { prisma } = await import("@/lib/db");
  // Only recent signups: anyone older than this is well past a trial and not worth a nudge.
  const where = { createdAt: { lt: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY_MS), gt: new Date(now.getTime() - 60 * DAY_MS) }, organization: { planTier: "free" } };

  let queued = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const users = await prisma.user.findMany({
      where,
      orderBy: { id: "asc" },
      take: SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, email: true, firstName: true, createdAt: true },
    });
    if (!users.length) break;
    cursor = users[users.length - 1].id;

    const ids = users.map((u) => u.id);
    const sessions = await prisma.trainerSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { createdAt: true }, _sum: { durationSeconds: true } });
    const sessBy = new Map(sessions.map((s) => [s.userId, s]));
    const sent = await prisma.ghlOutbox.groupBy({ by: ["userId"], where: { userId: { in: ids }, event: "went_quiet" }, _max: { createdAt: true } });
    const sentBy = new Map(sent.map((s) => [s.userId, s._max.createdAt]));

    for (const u of users) {
      const s = sessBy.get(u.id);
      const lastActive = s?._max.createdAt ?? u.createdAt;
      if (!isWentQuiet({ createdAt: u.createdAt, lastActive, now, plan: "free" })) continue;
      // One went_quiet per quiet spell: skip if one was queued since the last activity (or since trial end).
      const trialEnd = new Date(u.createdAt.getTime() + TRIAL_DAYS * DAY_MS);
      const since = now > trialEnd ? trialEnd : lastActive;
      const prior = sentBy.get(u.id);
      if (prior && prior > since) continue;
      const payload = makePayload(u, "went_quiet", "free", s?._sum.durationSeconds ?? 0, { occurredAt: lastActive.toISOString() });
      if (await enqueueGhlEvent(payload)) queued++;
    }
    if (users.length < SCAN_PAGE_SIZE) break;
  }
  return queued;
}

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

// ---- Pure decisions (unit tested) ----

/** Which event a newly stored graded call triggers, if any. Paid and post-trial users never move back. */
export function classifyGradedCall(i: { gradedCount: number; createdAt: Date; now: Date; plan: string; wasQuiet: boolean }): GhlEvent | null {
  if (i.plan !== "free") return null;
  const age = i.now.getTime() - i.createdAt.getTime();
  if (i.gradedCount <= 1) return "first_graded_call";
  if (age > TRIAL_DAYS * DAY_MS) return null;
  if (i.wasQuiet) return "active_trial";
  if (i.gradedCount === 2 && age <= ACTIVE_WINDOW_DAYS * DAY_MS) return "active_trial";
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

async function loadUser(userId: string) {
  const { prisma } = await import("@/lib/db");
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, createdAt: true, organization: { select: { planTier: true } } },
  });
}

async function buildPayload(userId: string, event: GhlEvent, extra: Partial<GhlPayload> & { occurredAt?: string } = {}): Promise<GhlPayload | null> {
  const user = await loadUser(userId);
  if (!user) return null;
  const { prisma } = await import("@/lib/db");
  const agg = await prisma.trainerSession.aggregate({ where: { userId }, _sum: { durationSeconds: true } });
  const plan = extra.plan ?? user.organization?.planTier ?? "free";
  return {
    event,
    occurredAt: extra.occurredAt ?? new Date().toISOString(),
    user: { id: user.id, email: user.email, firstName: user.firstName ?? "" },
    plan,
    segment: extra.segment ?? null,
    minuteCap: extra.minuteCap ?? minuteCapFor(plan),
    voiceMinutesUsed: event === "signup" ? 0 : Math.round(((agg._sum.durationSeconds ?? 0) / 60) * 10) / 10,
    source: extra.source ?? null,
    referredByPartner: extra.referredByPartner ?? null,
    stripeCustomerId: extra.stripeCustomerId ?? null,
  };
}

async function queue(userId: string, event: GhlEvent, extra?: Parameters<typeof buildPayload>[2]) {
  const payload = await buildPayload(userId, event, extra);
  if (payload) await enqueueGhlEvent(payload);
  await drainGhlOutbox();
}

// ---- Emitters. All return immediately; a GHL failure can never reach the caller. ----

export type SignupExtras = { segment?: string | null; source?: string | null; referredByPartner?: string | null };

/** Account created. `segment` must be a user-confirmed industry; it is never inferred. */
export function emitSignup(userId: string, extras: SignupExtras = {}): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => queue(userId, "signup", { ...extras, segment: confirmedSegment(extras.segment) }));
}

/** A graded call was stored. Decides between first_graded_call and active_trial. */
export function emitGradedCall(userId: string, createdAt: Date = new Date()): void {
  if (!ghlEnabled()) return;
  runAfterResponse(async () => {
    const { prisma } = await import("@/lib/db");
    const user = await loadUser(userId);
    if (!user) return;
    const graded = await prisma.trainerSession.findMany({ where: { userId, overallScore: { not: null } }, orderBy: { createdAt: "desc" }, take: 2, select: { createdAt: true } });
    const gradedCount = await prisma.trainerSession.count({ where: { userId, overallScore: { not: null } } });
    const prev = graded[1]?.createdAt;
    const quiet = await prisma.ghlOutbox.findFirst({ where: { userId, event: "went_quiet" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const event = classifyGradedCall({ gradedCount, createdAt: user.createdAt, now: createdAt, plan: user.organization?.planTier ?? "free", wasQuiet: !!quiet && (!prev || quiet.createdAt > prev) });
    if (event) await queue(userId, event, { occurredAt: createdAt.toISOString() });
  });
}

export type UpgradeInput = { userId: string; plan: "pro" | "team"; stripeCustomerId: string; minuteCap?: number; occurredAt?: string };

/**
 * Paid upgrade. Call this from the Stripe handler for checkout.session.completed and for
 * customer.subscription.updated when the subscription is paid. There is no Stripe code yet.
 */
export function emitUpgrade(input: UpgradeInput): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() =>
    queue(input.userId, "upgrade", { plan: input.plan, stripeCustomerId: input.stripeCustomerId, minuteCap: input.minuteCap ?? minuteCapFor(input.plan), occurredAt: input.occurredAt }),
  );
}

/** Daily scan: queue went_quiet for free users who stopped calling or whose trial ended. Returns how many were queued. */
export async function scanWentQuiet(now: Date = new Date()): Promise<number> {
  if (!ghlEnabled()) return 0;
  const { prisma } = await import("@/lib/db");
  // Only recent signups: anyone older than this is well past a trial and not worth a nudge.
  const users = await prisma.user.findMany({
    where: { createdAt: { lt: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY_MS), gt: new Date(now.getTime() - 60 * DAY_MS) }, organization: { planTier: "free" } },
    select: { id: true, createdAt: true },
    take: 500,
  });
  if (!users.length) return 0;
  const ids = users.map((u) => u.id);
  const last = await prisma.trainerSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { createdAt: true } });
  const lastBy = new Map(last.map((l) => [l.userId, l._max.createdAt]));
  const sent = await prisma.ghlOutbox.groupBy({ by: ["userId"], where: { userId: { in: ids }, event: "went_quiet" }, _max: { createdAt: true } });
  const sentBy = new Map(sent.map((s) => [s.userId, s._max.createdAt]));

  let queued = 0;
  for (const u of users) {
    const lastActive = lastBy.get(u.id) ?? u.createdAt;
    if (!isWentQuiet({ createdAt: u.createdAt, lastActive, now, plan: "free" })) continue;
    // One went_quiet per quiet spell: skip if one was queued since the last activity (or since trial end).
    const trialEnd = new Date(u.createdAt.getTime() + TRIAL_DAYS * DAY_MS);
    const since = now > trialEnd ? trialEnd : lastActive;
    const prior = sentBy.get(u.id);
    if (prior && prior > since) continue;
    const payload = await buildPayload(u.id, "went_quiet", { occurredAt: lastActive.toISOString() });
    if (payload && (await enqueueGhlEvent(payload))) queued++;
  }
  return queued;
}

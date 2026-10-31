import "server-only";
import { after } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ghlEnabled } from "./client";
import { drainGhlOutbox, enqueueGhlEvent, prismaOutboxStore } from "./outbox";
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
/** Users read per page by the quiet scan, and pages per run. The cursor is saved, so a bigger backlog continues next run. */
export const SCAN_PAGE_SIZE = 500;
export const SCAN_MAX_PAGES = 40;
const SCAN_CURSOR = "went_quiet";

// ---- Pure decisions (unit tested) ----

/**
 * The next lifecycle milestone for a user after a graded call, from what has already been issued (committed
 * outbox state), not from the call's position in a count. Milestones therefore come out in lifecycle order
 * (first_graded_call, then active_trial) whichever callback runs first. `now` is the call's own time.
 * Paid and post-trial users never move back.
 */
export function nextMilestone(i: {
  issued: ReadonlySet<string>;
  lastEvent: string | null;
  gradedCount: number;
  createdAt: Date;
  now: Date;
  plan: string;
}): GhlEvent | null {
  if (i.plan !== "free" || i.gradedCount < 1) return null;
  if (!i.issued.has("first_graded_call")) return "first_graded_call";
  const age = i.now.getTime() - i.createdAt.getTime();
  if (age > TRIAL_DAYS * DAY_MS) return null;
  // A call after went_quiet moves back to Active Trial.
  if (i.lastEvent === "went_quiet") return "active_trial";
  // The second graded call within a week of signup.
  if (!i.issued.has("active_trial") && i.gradedCount >= 2 && age <= ACTIVE_WINDOW_DAYS * DAY_MS) return "active_trial";
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

// ---- Per-user serialized allocation ----

type Tx = Prisma.TransactionClient;
type LockedUser = { id: string; email: string; firstName: string | null; createdAt: Date; plan: string };

/**
 * Runs `fn` in a transaction holding a per-user advisory lock, so two callbacks for one user never
 * allocate at once. Events are inserted inside it and the outbox `seq` is assigned there, which makes
 * `seq` follow lifecycle order per user. Everything inside must read through `tx` (committed state).
 */
async function withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      return fn(tx);
    },
    { timeout: 20_000 },
  );
}

type Extra = Partial<GhlPayload> & { occurredAt?: string };

function makePayload(user: { id: string; email: string; firstName: string | null }, event: GhlEvent, plan: string, voiceSeconds: number, extra: Extra = {}): GhlPayload {
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

async function loadLocked(tx: Tx, userId: string): Promise<LockedUser | null> {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, createdAt: true, organization: { select: { planTier: true } } },
  });
  return u ? { id: u.id, email: u.email, firstName: u.firstName, createdAt: u.createdAt, plan: u.organization?.planTier ?? "free" } : null;
}

/** What has been issued to GHL for this user so far, oldest first. */
async function readState(tx: Tx, userId: string) {
  const rows = await tx.ghlOutbox.findMany({ where: { userId }, orderBy: { seq: "asc" }, select: { event: true } });
  return { issued: new Set(rows.map((r) => r.event)), lastEvent: rows.length ? rows[rows.length - 1].event : null };
}

const voiceSeconds = async (tx: Tx, userId: string) => (await tx.trainerSession.aggregate({ where: { userId }, _sum: { durationSeconds: true } }))._sum.durationSeconds ?? 0;

/** Signup always precedes every other event, even when its own callback is late (that one then dedupes). */
async function ensureSignup(tx: Tx, u: LockedUser, issued: ReadonlySet<string>, extras: SignupExtras = {}) {
  if (issued.has("signup")) return;
  const payload = makePayload(u, "signup", "free", 0, { ...extras, segment: confirmedSegment(extras.segment), occurredAt: u.createdAt.toISOString() });
  await enqueueGhlEvent(payload, { store: prismaOutboxStore(tx) });
}

/** Enqueue, then try to deliver now. The cron drains whatever this leaves behind. */
const enqueueAndDrain = async (enqueue: () => Promise<unknown>) => {
  await enqueue();
  await drainGhlOutbox();
};

// ---- Emitters. All return immediately; a GHL failure can never reach the caller. ----

export type SignupExtras = { segment?: string | null; source?: string | null; referredByPartner?: string | null };

/** Queue signup (no delivery). Exported for tests; the app calls `emitSignup`. */
export async function enqueueSignup(userId: string, extras: SignupExtras = {}): Promise<void> {
  await withUserLock(userId, async (tx) => {
    const u = await loadLocked(tx, userId);
    if (!u) return;
    await ensureSignup(tx, u, (await readState(tx, userId)).issued, extras);
  });
}

/** Account created. `segment` must be a user-confirmed industry; it is never inferred. */
export function emitSignup(userId: string, extras: SignupExtras = {}): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => enqueueAndDrain(() => enqueueSignup(userId, extras)));
}

export type GradedSession = { id: string; createdAt: Date };

/**
 * Queue the next milestone after a stored graded call, if there is one. Runs under the user's lock and
 * reads committed state: a callback always runs after its own session committed, so the k-th callback to
 * take the lock sees at least k graded sessions. Milestones are handed out by what was already issued, so
 * concurrent or out-of-order callbacks get first_graded_call then active_trial, never the same milestone
 * twice and never one lost. Exported for tests.
 */
export async function enqueueGradedCall(userId: string, session: GradedSession): Promise<GhlEvent | null> {
  return withUserLock(userId, async (tx) => {
    const u = await loadLocked(tx, userId);
    if (!u) return null;
    const { issued, lastEvent } = await readState(tx, userId);
    const gradedWhere = { userId, overallScore: { not: null } };
    const gradedCount = await tx.trainerSession.count({ where: gradedWhere });
    const event = nextMilestone({ issued, lastEvent, gradedCount, createdAt: u.createdAt, now: session.createdAt, plan: u.plan });
    if (!event) return null;
    await ensureSignup(tx, u, issued);
    // The first call's date is the earliest committed graded session, whichever callback got here first.
    const first = event === "first_graded_call" ? await tx.trainerSession.findFirst({ where: gradedWhere, orderBy: { createdAt: "asc" }, select: { createdAt: true } }) : null;
    const occurredAt = (first?.createdAt ?? session.createdAt).toISOString();
    await enqueueGhlEvent(makePayload(u, event, u.plan, await voiceSeconds(tx, userId), { occurredAt }), { store: prismaOutboxStore(tx) });
    return event;
  });
}

/** A graded call was stored. Decides between first_graded_call and active_trial. */
export function emitGradedCall(userId: string, session: GradedSession): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => enqueueAndDrain(() => enqueueGradedCall(userId, session)));
}

export type UpgradeInput = { userId: string; plan: "pro" | "team"; stripeCustomerId: string; minuteCap?: number; occurredAt?: string };

/** Queue an upgrade (no delivery), after signup if that is missing. Exported for tests. */
export async function enqueueUpgrade(input: UpgradeInput): Promise<void> {
  await withUserLock(input.userId, async (tx) => {
    const u = await loadLocked(tx, input.userId);
    if (!u) return;
    await ensureSignup(tx, u, (await readState(tx, input.userId)).issued);
    const payload = makePayload(u, "upgrade", input.plan, await voiceSeconds(tx, input.userId), {
      plan: input.plan,
      stripeCustomerId: input.stripeCustomerId,
      minuteCap: input.minuteCap ?? minuteCapFor(input.plan),
      occurredAt: input.occurredAt,
    });
    await enqueueGhlEvent(payload, { store: prismaOutboxStore(tx) });
  });
}

/**
 * Paid upgrade. Call this from the Stripe handler for checkout.session.completed and for
 * customer.subscription.updated when the subscription is paid. There is no Stripe code yet.
 */
export function emitUpgrade(input: UpgradeInput): void {
  if (!ghlEnabled()) return;
  runAfterResponse(() => enqueueAndDrain(() => enqueueUpgrade(input)));
}

/**
 * Queue went_quiet for one user under their lock, re-reading committed activity so a call that landed
 * since the scan's page read wins. One went_quiet per quiet spell. Returns true when a row was queued.
 */
async function enqueueWentQuiet(userId: string, now: Date): Promise<boolean> {
  return withUserLock(userId, async (tx) => {
    const u = await loadLocked(tx, userId);
    if (!u) return false;
    const agg = await tx.trainerSession.aggregate({ where: { userId }, _max: { createdAt: true }, _sum: { durationSeconds: true } });
    const lastActive = agg._max.createdAt ?? u.createdAt;
    if (!isWentQuiet({ createdAt: u.createdAt, lastActive, now, plan: u.plan })) return false;
    const trialEnd = new Date(u.createdAt.getTime() + TRIAL_DAYS * DAY_MS);
    const since = now > trialEnd ? trialEnd : lastActive;
    const prior = await tx.ghlOutbox.findFirst({ where: { userId, event: "went_quiet" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (prior && prior.createdAt > since) return false;
    await ensureSignup(tx, u, (await readState(tx, userId)).issued);
    return enqueueGhlEvent(makePayload(u, "went_quiet", u.plan, agg._sum.durationSeconds ?? 0, { occurredAt: lastActive.toISOString() }), { store: prismaOutboxStore(tx) });
  });
}

/**
 * Daily scan: queue went_quiet for free users who stopped calling or whose trial ended. Pages through
 * candidates by id and saves where it stopped (GhlScanCursor), so a backlog larger than one run's page
 * budget continues on the next run instead of re-reading the same first users. At the end of the list the
 * cursor resets. Users already queued for the current quiet spell are skipped. Returns how many were queued.
 */
export async function scanWentQuiet(now: Date = new Date(), opts: { pageSize?: number; maxPages?: number } = {}): Promise<number> {
  if (!ghlEnabled()) return 0;
  const pageSize = opts.pageSize ?? SCAN_PAGE_SIZE;
  const maxPages = opts.maxPages ?? SCAN_MAX_PAGES;
  // Only recent signups: anyone older than this is well past a trial and not worth a nudge.
  const where = { createdAt: { lt: new Date(now.getTime() - QUIET_AFTER_DAYS * DAY_MS), gt: new Date(now.getTime() - 60 * DAY_MS) }, organization: { planTier: "free" } };

  let cursor = (await prisma.ghlScanCursor.findUnique({ where: { name: SCAN_CURSOR } }))?.lastId || undefined;
  let wrapped = false;
  let queued = 0;
  for (let page = 0; page < maxPages; page++) {
    const users = await prisma.user.findMany({
      where,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, createdAt: true },
    });
    if (!users.length) {
      // Past the last candidate: start over once in this run, so a finished pass does not waste a run.
      if (cursor && !wrapped) {
        cursor = undefined;
        wrapped = true;
        continue;
      }
      cursor = undefined;
      break;
    }
    cursor = users[users.length - 1].id;

    const ids = users.map((u) => u.id);
    const sessions = await prisma.trainerSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { createdAt: true } });
    const lastBy = new Map(sessions.map((s) => [s.userId, s._max.createdAt]));
    const sent = await prisma.ghlOutbox.groupBy({ by: ["userId"], where: { userId: { in: ids }, event: "went_quiet" }, _max: { createdAt: true } });
    const sentBy = new Map(sent.map((s) => [s.userId, s._max.createdAt]));

    for (const u of users) {
      // Cheap pre-filter from the page's data; enqueueWentQuiet re-checks under the user's lock.
      const lastActive = lastBy.get(u.id) ?? u.createdAt;
      if (!isWentQuiet({ createdAt: u.createdAt, lastActive, now, plan: "free" })) continue;
      const trialEnd = new Date(u.createdAt.getTime() + TRIAL_DAYS * DAY_MS);
      const prior = sentBy.get(u.id);
      if (prior && prior > (now > trialEnd ? trialEnd : lastActive)) continue;
      if (await enqueueWentQuiet(u.id, now)) queued++;
    }
    if (users.length < pageSize) {
      cursor = undefined;
      break;
    }
  }
  await prisma.ghlScanCursor.upsert({ where: { name: SCAN_CURSOR }, create: { name: SCAN_CURSOR, lastId: cursor ?? "" }, update: { lastId: cursor ?? "" } });
  return queued;
}

import "server-only";
import type { Prisma, TrainerSession, UsageAllowance } from "@prisma/client";
import { prisma } from "./db";
import {
  CONNECT_WINDOW_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MAX_CALL_SECONDS, capFor, isPlanTier, periodFor, premiumVoiceCap, secondsUntilCap, settleCall,
  type CallEndReasonId, type CallOutcome, type PlanTier,
} from "./usagePlan";

/**
 * Voice minute metering. The ledger (UsageEntry) is the source of truth and UsageAllowance.minutesUsed
 * is its cached sum for the current period. Every cap check goes through `checkCap`, so a daily or
 * spend cap can be added in one place later.
 */

type Tx = Prisma.TransactionClient;

/**
 * A metered voice call has a TrainerSession row from the moment it starts, with an empty transcript until
 * the client saves the call. Lists and team numbers count only calls that have a transcript.
 */
export const HAS_TRANSCRIPT: Prisma.TrainerSessionWhereInput = { NOT: { transcript: { equals: [] } } };

type Subject = { userId: string } | { organizationId: string };

export interface Resolved {
  allowance: UsageAllowance;
  /** True when minutes come from the organization's Team pool. */
  pooled: boolean;
  plan: PlanTier;
  premiumVoice: boolean;
  remaining: number;
}

const planOf = (v: unknown): PlanTier => (isPlanTier(v) ? v : "free");

/**
 * The allowance row for a user or a Team pool, created on first use. Also the one place caps change:
 * it re-derives plan and cap from the owner's row (so a seat added, an upgrade or a downgrade lands
 * immediately) and rolls the period when the anchor date has passed. The anchor itself never moves,
 * and a plan change keeps minutesUsed; only a new period resets it, with no rollover.
 */
export async function ensureAllowance(db: Tx, subject: Subject, now: Date): Promise<UsageAllowance> {
  let plan: PlanTier;
  let cap: number;
  let anchor: Date;
  let existing: UsageAllowance | null;
  if ("userId" in subject) {
    const user = await db.user.findUniqueOrThrow({ where: { id: subject.userId }, select: { planTier: true, usageAnchorAt: true } });
    plan = planOf(user.planTier) === "team" ? "free" : planOf(user.planTier);
    cap = capFor(plan);
    anchor = user.usageAnchorAt;
    existing = await db.usageAllowance.findUnique({ where: { userId: subject.userId } });
  } else {
    const org = await db.organization.findUniqueOrThrow({ where: { id: subject.organizationId }, select: { planTier: true, seatCount: true, createdAt: true } });
    plan = org.planTier === "team" ? "team" : "free";
    cap = capFor(plan, org.seatCount);
    anchor = org.createdAt;
    existing = await db.usageAllowance.findUnique({ where: { organizationId: subject.organizationId } });
  }
  const period = periodFor(anchor, now);
  if (!existing) {
    return db.usageAllowance.create({
      data: { ...subject, planTier: plan, minutesCap: cap, anchorAt: anchor, periodStart: period.start, periodEnd: period.end, minutesUsed: 0 },
    });
  }
  const data: Prisma.UsageAllowanceUpdateInput = {};
  if (existing.planTier !== plan) data.planTier = plan;
  if (existing.minutesCap !== cap) data.minutesCap = cap;
  if (existing.anchorAt.getTime() !== anchor.getTime()) data.anchorAt = anchor;
  if (existing.periodStart.getTime() !== period.start.getTime()) {
    data.periodStart = period.start;
    data.periodEnd = period.end;
    data.minutesUsed = 0;
  }
  return Object.keys(data).length ? db.usageAllowance.update({ where: { id: existing.id }, data }) : existing;
}

/** Who pays for this user's minutes, and how many are left right now. Null when the user does not exist. */
export async function resolveAllowance(db: Tx, userId: string, now: Date): Promise<Resolved | null> {
  const user = await db.user.findUnique({ where: { id: userId }, include: { organization: true } });
  if (!user) return null;
  const org = user.organization;
  const pooled = !!org && org.planTier === "team";
  const allowance = await ensureAllowance(db, pooled ? { organizationId: org.id } : { userId }, now);
  return {
    allowance,
    pooled,
    plan: pooled ? "team" : planOf(user.planTier) === "team" ? "free" : planOf(user.planTier),
    premiumVoice: pooled ? org.premiumVoice : user.premiumVoice,
    remaining: Math.max(0, allowance.minutesCap - allowance.minutesUsed),
  };
}

/** The cap check (rule 11): enough left for at least one minute. */
export function checkCap(r: Pick<Resolved, "remaining">): { ok: true } | { ok: false; error: "cap_reached" } {
  return r.remaining >= 1 ? { ok: true } : { ok: false, error: "cap_reached" };
}

// ---- Starting a call --------------------------------------------------------------------------

export interface ScenarioInfo { id: string; title?: string; industry?: string; difficulty?: string }

export type BeginResult =
  | { ok: true; callId: string; remaining: number; pooled: boolean }
  | { ok: false; error: "cap_reached" | "no_organization" | "user_not_found" };

/**
 * Cap check, then the TrainerSession that every later metering write is keyed by. Call before minting
 * a provider session. The transcript starts empty and is filled when the client saves the call.
 */
export async function beginCall(userId: string, scenario: ScenarioInfo, now = new Date()): Promise<BeginResult> {
  return prisma.$transaction(async (tx) => {
    await settleStale(tx, userId, now);
    const r = await resolveAllowance(tx, userId, now);
    if (!r) return { ok: false, error: "user_not_found" } as const;
    const check = checkCap(r);
    if (!check.ok) return check;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    if (!user?.organizationId) return { ok: false, error: "no_organization" } as const;
    const session = await tx.trainerSession.create({
      data: {
        userId,
        organizationId: user.organizationId,
        createdAt: now,
        scenarioId: scenario.id,
        scenarioTitle: scenario.title,
        scenarioCategory: scenario.industry,
        scenarioDifficulty: scenario.difficulty,
        transcript: [],
      },
    });
    return { ok: true, callId: session.id, remaining: r.remaining, pooled: r.pooled } as const;
  });
}

// ---- During a call ----------------------------------------------------------------------------

export type HeartbeatState = "connected" | "ok" | "recovering";
export type HeartbeatResult =
  | { found: false }
  | { found: true; stop: false; secondsLeft: number }
  | { found: true; stop: true; reason: "cap_reached" | "max_duration" | "ended"; settlement: CallResult | null };

/**
 * Client heartbeat. The first "connected" fixes connectedAt on the server clock; "recovering" marks the
 * start of a network wobble (cleared by the next "ok"). Answers stop=true once the cap or the 24 hour
 * limit is reached, and settles the call right then.
 */
export async function heartbeat(userId: string, callId: string, state: HeartbeatState, now = new Date()): Promise<HeartbeatResult> {
  return prisma.$transaction(async (tx) => {
    const s = await tx.trainerSession.findUnique({ where: { id: callId } });
    if (!s || s.userId !== userId) return { found: false } as const;
    if (s.endedAt) return { found: true, stop: true, reason: "ended", settlement: null } as const;

    const data: Prisma.TrainerSessionUpdateInput = { lastHeartbeatAt: now };
    let connectedAt = s.connectedAt;
    if (!connectedAt && state === "connected" && now.getTime() - s.createdAt.getTime() <= CONNECT_WINDOW_SECONDS * 1000) {
      connectedAt = now;
      data.connectedAt = now;
    }
    if (state === "recovering") {
      if (!s.degradedAt) data.degradedAt = now;
    } else if (s.degradedAt) {
      data.degradedAt = null;
    }
    await tx.trainerSession.update({ where: { id: s.id }, data });
    if (!connectedAt) return { found: true, stop: false, secondsLeft: MAX_CALL_SECONDS } as const;

    const r = await resolveAllowance(tx, userId, now);
    const elapsed = Math.max(0, Math.floor((now.getTime() - connectedAt.getTime()) / 1000));
    const left = Math.min(secondsUntilCap(r?.remaining ?? 0, elapsed), MAX_CALL_SECONDS - elapsed);
    if (left > 0) return { found: true, stop: false, secondsLeft: left } as const;
    const reason = (r?.remaining ?? 0) * 60 - elapsed <= 0 ? "cap_reached" : "max_duration";
    const settlement = await settle(tx, { ...s, connectedAt, lastHeartbeatAt: now, degradedAt: null }, reason, now);
    return { found: true, stop: true, reason, settlement } as const;
  });
}

// ---- Ending a call ----------------------------------------------------------------------------

export interface CallResult {
  outcome: CallOutcome;
  endReason: CallEndReasonId;
  billableSeconds: number;
  billedMinutes: number;
  creditedMinutes: number;
}

type OpenSession = TrainerSession;

/** When the call really ended, on the server clock. Rule 3: the earliest of the candidates wins. */
function endedAtFor(s: OpenSession, reason: CallEndReasonId, now: Date): Date {
  let end = now.getTime();
  // A drop that never recovered ended when it started, not 10 seconds later when the client gave up.
  if (reason === "network_drop" && s.degradedAt) end = Math.min(end, s.degradedAt.getTime());
  // A silent client ends at its last heartbeat plus 30 seconds.
  if (s.lastHeartbeatAt) end = Math.min(end, s.lastHeartbeatAt.getTime() + HEARTBEAT_TIMEOUT_SECONDS * 1000);
  if (s.connectedAt) end = Math.max(end, s.connectedAt.getTime());
  return new Date(end);
}

async function settle(tx: Tx, s: OpenSession, requested: CallEndReasonId, now: Date): Promise<CallResult | null> {
  const reason: CallEndReasonId = s.connectedAt ? requested : "failed_connect";
  const r = await resolveAllowance(tx, s.userId, now);
  if (!r) return null;
  const endedAt = endedAtFor(s, reason, now);
  const st = settleCall({ connectedAt: s.connectedAt, endedAt, reason, remainingMinutes: r.remaining });

  // Whoever flips endedAt from null owns the settlement, so a repeated end event writes nothing.
  const won = await tx.trainerSession.updateMany({
    where: { id: s.id, endedAt: null },
    data: { endedAt, endReason: st.endReason, billableSeconds: st.billableSeconds, billedMinutes: st.netMinutes },
  });
  if (won.count === 0) return null;

  if (st.grossMinutes > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: r.allowance.id, trainerSessionId: s.id, kind: "voice_call", minutes: st.grossMinutes } });
  }
  if (st.creditMinutes > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: r.allowance.id, trainerSessionId: s.id, kind: "credit_drop", minutes: -st.creditMinutes } });
  }
  if (st.netMinutes > 0) {
    await tx.usageAllowance.update({ where: { id: r.allowance.id }, data: { minutesUsed: { increment: st.netMinutes } } });
  }
  return { outcome: st.outcome, endReason: st.endReason, billableSeconds: st.billableSeconds, billedMinutes: st.netMinutes, creditedMinutes: st.creditMinutes };
}

function storedResult(s: OpenSession): CallResult {
  const gross = s.connectedAt ? Math.ceil(s.billableSeconds / 60) : 0;
  const credited = Math.max(0, gross - s.billedMinutes);
  return {
    outcome: !s.connectedAt ? "failed_connect" : credited > 0 ? "dropped_credited" : "billed",
    endReason: s.endReason ?? "failed_connect",
    billableSeconds: s.billableSeconds,
    billedMinutes: s.billedMinutes,
    creditedMinutes: credited,
  };
}

/**
 * End a call and bill it, once. The only inputs are the call id and why the client says it ended; the
 * times come from the server's own timestamps, so a client cannot shorten or lengthen what it is charged.
 * Returns null when the call does not belong to this user.
 */
export async function endCall(userId: string, callId: string, reason: CallEndReasonId, now = new Date()): Promise<CallResult | null> {
  return prisma.$transaction(async (tx) => {
    const s = await tx.trainerSession.findUnique({ where: { id: callId } });
    if (!s || s.userId !== userId) return null;
    if (s.endedAt) return storedResult(s);
    const done = await settle(tx, s, reason, now);
    if (done) return done;
    const again = await tx.trainerSession.findUnique({ where: { id: callId } });
    return again ? storedResult(again) : null;
  });
}

/**
 * Settles this user's calls that nobody ended: never connected within 15 minutes, or silent for more than
 * 30 seconds after the last heartbeat (rule 3). Runs lazily before a cap check or a usage read.
 */
export async function settleStale(tx: Tx, userId: string, now: Date): Promise<void> {
  const open = await tx.trainerSession.findMany({ where: { userId, endedAt: null } });
  for (const s of open) {
    if (!s.connectedAt) {
      if (now.getTime() - s.createdAt.getTime() > CONNECT_WINDOW_SECONDS * 1000) await settle(tx, s, "failed_connect", now);
    } else if (s.lastHeartbeatAt && now.getTime() - s.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_SECONDS * 1000) {
      await settle(tx, s, "heartbeat_timeout", now);
    }
  }
}

// ---- Support credits and the usage summary ----------------------------------------------------

/** Support credit (rule 20): a negative ledger entry, minutesUsed lowered by the same amount, and an audit event. */
export async function creditManual(input: { targetUserId: string; minutes: number; actorId: string; reason: string }, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const r = await resolveAllowance(tx, input.targetUserId, now);
    if (!r) return null;
    const entry = await tx.usageEntry.create({
      data: { userId: input.targetUserId, allowanceId: r.allowance.id, kind: "credit_manual", minutes: -input.minutes },
    });
    const allowance = await tx.usageAllowance.update({ where: { id: r.allowance.id }, data: { minutesUsed: { decrement: input.minutes } } });
    await tx.auditEvent.create({
      data: {
        userId: input.actorId,
        action: "usage.credit_manual",
        resource: entry.id,
        metadata: { targetUserId: input.targetUserId, minutes: input.minutes, reason: input.reason, allowanceId: r.allowance.id },
      },
    });
    return { entryId: entry.id, minutesUsed: allowance.minutesUsed };
  });
}

export interface UsageSummary {
  plan: PlanTier;
  pooled: boolean;
  minutesCap: number;
  minutesUsed: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
  premiumVoice: { enabled: boolean; minutesCap: number };
  entries: { id: string; kind: string; minutes: number; createdAt: string }[];
}

/** What the usage panel shows. Everything comes from the allowance row and this user's ledger entries. */
export async function usageSummary(userId: string, now = new Date()): Promise<UsageSummary | null> {
  return prisma.$transaction(async (tx) => {
    await settleStale(tx, userId, now);
    const r = await resolveAllowance(tx, userId, now);
    if (!r) return null;
    const entries = await tx.usageEntry.findMany({
      where: { allowanceId: r.allowance.id, userId, createdAt: { gte: r.allowance.periodStart } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      plan: r.plan,
      pooled: r.pooled,
      minutesCap: r.allowance.minutesCap,
      minutesUsed: r.allowance.minutesUsed,
      remaining: r.remaining,
      periodStart: r.allowance.periodStart.toISOString(),
      periodEnd: r.allowance.periodEnd.toISOString(),
      premiumVoice: { enabled: r.premiumVoice, minutesCap: r.premiumVoice ? premiumVoiceCap(r.allowance.minutesCap) : 0 },
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, minutes: e.minutes, createdAt: e.createdAt.toISOString() })),
    };
  });
}

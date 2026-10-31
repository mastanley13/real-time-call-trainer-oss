import "server-only";
import type { Prisma, TrainerSession, UsageAllowance } from "@prisma/client";
import { prisma } from "./db";
import {
  CONNECT_WINDOW_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MAX_CALL_SECONDS, MAX_CONNECT_LAG_SECONDS, MAX_RESERVE_MINUTES,
  OVERRUN_GRACE_SECONDS, VOICE_BLOCK_SECONDS,
  capFor, isPlanTier, maxMinutesAfter, periodFor, premiumVoiceCap, settleCall, splitAcrossBoundary,
  type CallEndReasonId, type CallOutcome, type PlanTier,
} from "./usagePlan";

/**
 * Voice minute metering. The ledger (UsageEntry) is the source of truth and UsageAllowance.minutesUsed
 * is its cached sum for the current period. Every cap check goes through `checkCap`, so a daily or
 * spend cap can be added in one place later.
 *
 * Trust model: the browser holds a direct connection to the voice provider, so nothing the browser says
 * is taken as proof of how long a call ran. A call reserves its minutes on the allowance when it is minted
 * (that is also its server-side maximum length), the billing clock starts from the server's mint time, and
 * a call that goes silent is billed as if it ran until the server noticed, up to its reservation.
 *
 * Neither voice provider is ended from here (the browser holds the connection), so the reservation is a
 * billing clamp, not a hard stop. Calls that visibly outlive it are flagged (see `flagOverrun`).
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
  /** Cap minus used: what the plan still has this period. */
  remaining: number;
  /** remaining minus what open calls have reserved: what a new call can take. */
  available: number;
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
    // A new period starts clean, except that calls still open from the old one may run into it: each holds
    // the minutes it can still use here (its carry), so nothing else can take them before it settles.
    // Only one caller wins the swap on periodStart, so the carry is computed and written once.
    const carry = await openCarry(db, existing, period.start, cap);
    const won = await db.usageAllowance.updateMany({
      where: { id: existing.id, periodStart: existing.periodStart },
      data: {
        ...data,
        periodStart: period.start,
        periodEnd: period.end,
        minutesUsed: 0,
        minutesReserved: carry.minutes,
        premiumMinutesUsed: 0,
        premiumMinutesReserved: carry.premium,
        version: { increment: 1 },
      },
    });
    if (won.count === 1) {
      for (const c of carry.calls) await db.trainerSession.update({ where: { id: c.id }, data: { carriedMinutes: c.minutes, carriedPremiumMinutes: c.premium } });
    }
    return db.usageAllowance.findUniqueOrThrow({ where: { id: existing.id } });
  }
  return Object.keys(data).length ? db.usageAllowance.update({ where: { id: existing.id }, data }) : existing;
}

/**
 * What each open call of this allowance holds in the period starting at `boundary`: the minutes it can still
 * use after that moment, taken in start order until the new cap (and the Premium limit) is used up.
 */
async function openCarry(db: Tx, existing: UsageAllowance, boundary: Date, cap: number) {
  const open = await db.trainerSession.findMany({ where: { allowanceId: existing.id, endedAt: null }, orderBy: { createdAt: "asc" } });
  const premiumCap = premiumVoiceCap(cap);
  let minutes = 0;
  let premium = 0;
  const calls: { id: string; minutes: number; premium: number }[] = [];
  for (const s of open) {
    const spill = maxMinutesAfter({ startMs: billingStart(s).getTime(), reservedMinutes: s.reservedMinutes, boundaryMs: boundary.getTime() });
    const take = Math.max(0, Math.min(spill, cap - minutes));
    const premiumTake = Math.max(0, Math.min(take, s.premiumReservedMinutes, premiumCap - premium));
    minutes += take;
    premium += premiumTake;
    if (take !== s.carriedMinutes || premiumTake !== s.carriedPremiumMinutes) calls.push({ id: s.id, minutes: take, premium: premiumTake });
  }
  return { minutes, premium, calls };
}

/** The allowance a stored call was started against, brought up to date. Null when the row is gone. */
async function ensureAllowanceById(db: Tx, allowanceId: string, now: Date): Promise<UsageAllowance | null> {
  const a = await db.usageAllowance.findUnique({ where: { id: allowanceId } });
  if (!a) return null;
  return ensureAllowance(db, a.userId ? { userId: a.userId } : { organizationId: a.organizationId! }, now);
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
    available: Math.max(0, allowance.minutesCap - allowance.minutesUsed - allowance.minutesReserved),
  };
}

/** The cap check (rule 11): enough left for at least one minute. */
export function checkCap(r: Pick<Resolved, "remaining">): { ok: true } | { ok: false; error: "cap_reached" } {
  return r.remaining >= 1 ? { ok: true } : { ok: false, error: "cap_reached" };
}

// ---- Voice engine -----------------------------------------------------------------------------

export type VoiceEngine = "premium" | "standard";

/**
 * Which engine the NEXT minted session uses, and how many Premium minutes it holds. Premium needs the add-on
 * and a free share of the 60% Premium limit: used plus reserved by open calls, so concurrent calls cannot all
 * pick Premium. A premium call holds at most what is left of that share (up to its own reservation). It is
 * never ended at the limit, but the provider session cannot change engine mid-call, so minutes past its
 * Premium share are booked as standard and the call's reservation bounds that overshoot.
 */
export function chooseEngine(
  r: Pick<Resolved, "premiumVoice"> & { allowance: Pick<UsageAllowance, "minutesCap" | "premiumMinutesUsed" | "premiumMinutesReserved"> },
  reserve: number,
): { engine: VoiceEngine; premiumMinutes: number } {
  if (!r.premiumVoice) return { engine: "standard", premiumMinutes: 0 };
  const left = premiumVoiceCap(r.allowance.minutesCap) - r.allowance.premiumMinutesUsed - r.allowance.premiumMinutesReserved;
  return left >= 1 ? { engine: "premium", premiumMinutes: Math.min(reserve, left) } : { engine: "standard", premiumMinutes: 0 };
}

// ---- Starting a call --------------------------------------------------------------------------

export interface ScenarioInfo { id: string; title?: string; industry?: string; difficulty?: string }

export type BeginResult =
  | { ok: true; callId: string; remaining: number; pooled: boolean; engine: VoiceEngine; maxSeconds: number }
  | { ok: false; error: "cap_reached" | "minutes_reserved" | "no_organization" | "user_not_found" | "standard_unavailable" }
  | { ok: false; error: "voice_blocked"; retryAfterSeconds: number };

const RESERVE_ATTEMPTS = 5;

/**
 * Cap check, reservation, then the TrainerSession that every later metering write is keyed by. Call before
 * minting a provider session. The reservation is what the call may use at most (`maxSeconds`), and it is
 * taken with a compare-and-swap on the allowance row, so two calls (or two Team members) cannot reserve
 * the same minutes. The Premium share is reserved in the same swap. `standardAvailable: false` means the
 * server has no standard engine configured: a call that is not entitled to Premium is then refused rather
 * than run on Premium for free.
 */
export async function beginCall(userId: string, scenario: ScenarioInfo, now = new Date(), opts: { standardAvailable?: boolean } = {}): Promise<BeginResult> {
  return prisma.$transaction(async (tx) => {
    await settleStale(tx, userId, now);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true, voiceBlockedUntil: true } });
    if (!user) return { ok: false, error: "user_not_found" } as const;
    if (user.voiceBlockedUntil && user.voiceBlockedUntil.getTime() > now.getTime()) {
      return { ok: false, error: "voice_blocked", retryAfterSeconds: Math.ceil((user.voiceBlockedUntil.getTime() - now.getTime()) / 1000) } as const;
    }
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const r = await resolveAllowance(tx, userId, now);
      if (!r) return { ok: false, error: "user_not_found" } as const;
      const check = checkCap(r);
      if (!check.ok) return check;
      if (!user.organizationId) return { ok: false, error: "no_organization" } as const;
      if (r.available < 1) return { ok: false, error: "minutes_reserved" } as const;

      const reserve = Math.min(r.available, MAX_RESERVE_MINUTES);
      const { engine, premiumMinutes } = chooseEngine(r, reserve);
      if (engine === "standard" && opts.standardAvailable === false) return { ok: false, error: "standard_unavailable" } as const;
      const claimed = await tx.usageAllowance.updateMany({
        where: { id: r.allowance.id, version: r.allowance.version },
        data: { version: { increment: 1 }, minutesReserved: { increment: reserve }, premiumMinutesReserved: { increment: premiumMinutes } },
      });
      if (claimed.count === 0) continue; // someone else changed the allowance since we read it: read again

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
          allowanceId: r.allowance.id,
          allowancePeriodStart: r.allowance.periodStart,
          reservedMinutes: reserve,
          premiumReservedMinutes: premiumMinutes,
          engineTier: engine,
        },
      });
      return { ok: true, callId: session.id, remaining: r.remaining, pooled: r.pooled, engine, maxSeconds: reserve * 60 } as const;
    }
    return { ok: false, error: "minutes_reserved" } as const;
  });
}

// ---- Server-side clock ------------------------------------------------------------------------

type OpenSession = TrainerSession;

/**
 * When billing starts: the client's "connected" heartbeat, but never later than the mint time plus
 * MAX_CONNECT_LAG_SECONDS. A client that withholds "connected" is billed from the cutoff instead of for nothing.
 */
function billingStart(s: Pick<OpenSession, "createdAt" | "connectedAt">): Date {
  const cutoff = s.createdAt.getTime() + MAX_CONNECT_LAG_SECONDS * 1000;
  return new Date(s.connectedAt ? Math.min(s.connectedAt.getTime(), cutoff) : cutoff);
}

/** The most seconds this call may run: what it reserved at mint time, and never more than the 24 hour limit. */
const maxSecondsOf = (reservedMinutes: number) => Math.min(reservedMinutes * 60, MAX_CALL_SECONDS);

// ---- During a call ----------------------------------------------------------------------------

export type HeartbeatState = "connected" | "ok" | "recovering";
export type HeartbeatResult =
  | { found: false }
  | { found: true; stop: false; secondsLeft: number }
  | { found: true; stop: true; reason: "cap_reached" | "max_duration" | "ended"; settlement: CallResult | null };

/**
 * Client heartbeat. The first "connected" fixes connectedAt on the server clock; "recovering" marks the
 * start of a network wobble (cleared by the next "ok"). Answers stop=true once the call's reserved
 * minutes or the 24 hour limit are used up, and settles the call right then. The clock runs from the
 * server's mint time whether or not the client ever says "connected".
 */
export async function heartbeat(userId: string, callId: string, state: HeartbeatState, now = new Date()): Promise<HeartbeatResult> {
  return prisma.$transaction(async (tx) => {
    const s = await tx.trainerSession.findUnique({ where: { id: callId } });
    if (!s || s.userId !== userId) return { found: false } as const;
    if (s.endedAt) {
      // The server already told this client to stop. Still heartbeating well after a clamped end means the
      // browser kept the provider session running past its reservation.
      const clamped = s.endReason === "cap_reached" || s.endReason === "max_duration";
      if (clamped && now.getTime() - s.endedAt.getTime() > OVERRUN_GRACE_SECONDS * 1000) await flagOverrun(tx, s, now);
      return { found: true, stop: true, reason: "ended", settlement: null } as const;
    }

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

    const limit = await limitSeconds(tx, s, now);
    const start = billingStart({ createdAt: s.createdAt, connectedAt });
    const elapsed = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
    const left = Math.min(limit, MAX_CALL_SECONDS) - elapsed;
    if (left > 0) return { found: true, stop: false, secondsLeft: left } as const;
    const reason = limit - elapsed <= 0 ? "cap_reached" : "max_duration";
    const settlement = await settle(tx, { ...s, connectedAt, lastHeartbeatAt: now, degradedAt: null }, reason, now);
    return { found: true, stop: true, reason, settlement } as const;
  });
}

/** Seconds a call may run in total. A call from before reservations existed uses what the allowance has left. */
async function limitSeconds(tx: Tx, s: OpenSession, now: Date): Promise<number> {
  if (s.allowanceId) return maxSecondsOf(s.reservedMinutes);
  const r = await resolveAllowance(tx, s.userId, now);
  return (r?.remaining ?? 0) * 60;
}

// ---- Ending a call ----------------------------------------------------------------------------

export interface CallResult {
  outcome: CallOutcome;
  endReason: CallEndReasonId;
  billableSeconds: number;
  billedMinutes: number;
  creditedMinutes: number;
}

/** When the call really ended, on the server clock. Never before it started billing. */
function endedAtFor(s: OpenSession, reason: CallEndReasonId, now: Date, start: Date): Date {
  let end = now.getTime();
  // A drop that never recovered ended when it started, not 10 seconds later when the client gave up.
  if (reason === "network_drop" && s.degradedAt) end = Math.min(end, s.degradedAt.getTime());
  // A silent client is not trusted to have stopped: it is billed until the server noticed, and the
  // reservation caps that. Heartbeat timestamps are not used to shorten a call.
  return new Date(Math.max(end, start.getTime()));
}

/** The allowance a call is charged to, and whether it is still the period the call started in. */
async function chargeTarget(tx: Tx, s: OpenSession, now: Date): Promise<{ allowance: UsageAllowance; samePeriod: boolean; remaining: number; call: OpenSession } | null> {
  if (!s.allowanceId) {
    const r = await resolveAllowance(tx, s.userId, now);
    return r ? { allowance: r.allowance, samePeriod: true, remaining: r.remaining, call: s } : null;
  }
  const allowance = await ensureAllowanceById(tx, s.allowanceId, now);
  if (!allowance) return null;
  const samePeriod = !s.allowancePeriodStart || s.allowancePeriodStart.getTime() === allowance.periodStart.getTime();
  // A rollover just now may have written this call's carry, so read the call again.
  const call = samePeriod ? s : (await tx.trainerSession.findUnique({ where: { id: s.id } })) ?? s;
  return { allowance, samePeriod, remaining: s.reservedMinutes, call };
}

/** What one settlement writes: the part charged to the current period and the part that belongs to a finished one. */
interface Booking {
  /** Charged to the current period. */
  gross: number;
  credit: number;
  net: number;
  /** Net minutes that ran in a period that has already ended: ledger only, its counters are gone. */
  priorNet: number;
  priorAt: Date;
  billableSeconds: number;
  endReason: CallEndReasonId;
  /** Reservation held on the current allowance by this call, to release. */
  releaseMinutes: number;
  releasePremium: number;
  /** Premium share of `net`. */
  premiumNet: number;
}

async function settle(tx: Tx, original: OpenSession, requested: CallEndReasonId, now: Date): Promise<CallResult | null> {
  const target = await chargeTarget(tx, original, now);
  if (!target) return null;
  const { allowance, samePeriod } = target;
  const s: OpenSession = { ...original, carriedMinutes: target.call.carriedMinutes, carriedPremiumMinutes: target.call.carriedPremiumMinutes };

  const start = billingStart(s);
  const naturalEnd = endedAtFor(s, requested, now, start);
  // Connected means the client said so, or the call outlived the connect cutoff and so must have run.
  const connected = !!s.connectedAt || naturalEnd.getTime() > start.getTime();
  const reason: CallEndReasonId = connected ? requested : "failed_connect";

  const endedAt = connected ? naturalEnd : now;
  const st = settleCall({ connectedAt: connected ? start : null, endedAt, reason, remainingMinutes: target.remaining });
  // A stale call keeps its own reason when the reservation is what clamped it.
  let endReason: CallEndReasonId = requested === "heartbeat_timeout" && st.endReason === "cap_reached" ? "heartbeat_timeout" : st.endReason;

  const hasReservation = !!s.allowanceId;
  let b: Booking;
  if (samePeriod) {
    b = {
      gross: st.grossMinutes, credit: st.creditMinutes, net: st.netMinutes, priorNet: 0, priorAt: now, billableSeconds: st.billableSeconds, endReason,
      releaseMinutes: hasReservation ? s.reservedMinutes : 0,
      releasePremium: s.premiumReservedMinutes,
      premiumNet: s.engineTier === "premium" ? Math.min(st.netMinutes, s.premiumReservedMinutes) : 0,
    };
  } else {
    // The call started in an earlier period. Its whole length is shared out between that period (ledger
    // only, the counters have been reset) and the one after it. In the current period it may use only what
    // the rollover reserved for it, which is what keeps concurrent settlements inside the cap.
    const boundary = periodFor(allowance.anchorAt, s.allowancePeriodStart!).end;
    const split = splitAcrossBoundary({ startMs: start.getTime(), billableSeconds: st.billableSeconds, boundaryMs: boundary.getTime(), grossMinutes: st.grossMinutes });
    const credited = st.creditMinutes > 0;
    const inCurrent = boundary.getTime() === allowance.periodStart.getTime();
    const newGross = inCurrent ? Math.min(split.newMinutes, s.carriedMinutes) : 0;
    const clamped = inCurrent && newGross < split.newMinutes;
    if (clamped) endReason = "cap_reached";
    const lost = inCurrent ? 0 : split.newMinutes;
    const credit = credited ? newGross : 0;
    b = {
      gross: newGross, credit, net: newGross - credit,
      priorNet: credited ? 0 : split.oldMinutes + lost,
      priorAt: new Date(boundary.getTime() - 1),
      billableSeconds: clamped ? Math.min(st.billableSeconds, split.oldSeconds + newGross * 60) : st.billableSeconds,
      endReason,
      releaseMinutes: s.carriedMinutes,
      releasePremium: s.carriedPremiumMinutes,
      premiumNet: s.engineTier === "premium" ? Math.min(newGross - credit, s.carriedPremiumMinutes) : 0,
    };
  }

  // Whoever flips endedAt from null owns the settlement, so a repeated end event writes nothing.
  const won = await tx.trainerSession.updateMany({
    where: { id: s.id, endedAt: null },
    data: { endedAt, endReason: b.endReason, billableSeconds: b.billableSeconds, billedMinutes: b.net + b.priorNet },
  });
  if (won.count === 0) return null;

  if (b.gross > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "voice_call", minutes: b.gross } });
  }
  if (b.credit > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "credit_drop", minutes: -b.credit } });
  }
  if (b.priorNet > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "voice_call_prior", minutes: b.priorNet, createdAt: b.priorAt } });
  }
  // Release the reservation and book the minutes in one atomic update; increments never read a stale value.
  if (b.net > 0 || b.releaseMinutes > 0 || b.releasePremium > 0) {
    await tx.usageAllowance.update({
      where: { id: allowance.id },
      data: {
        minutesUsed: { increment: b.net },
        minutesReserved: { decrement: b.releaseMinutes },
        premiumMinutesUsed: { increment: b.premiumNet },
        premiumMinutesReserved: { decrement: b.releasePremium },
        version: { increment: 1 },
      },
    });
  }
  // A client that reports the end long after the reservation ran out kept the provider session open.
  const clampedEnd = b.endReason === "cap_reached" || b.endReason === "max_duration";
  const overranBy = now.getTime() - (start.getTime() + b.billableSeconds * 1000);
  if (connected && hasReservation && clampedEnd && requested !== "heartbeat_timeout" && overranBy > OVERRUN_GRACE_SECONDS * 1000) {
    await flagOverrun(tx, s, now);
  }
  return { outcome: st.outcome, endReason: b.endReason, billableSeconds: b.billableSeconds, billedMinutes: b.net + b.priorNet, creditedMinutes: st.creditMinutes };
}

/**
 * Reconciliation for calls that outlive their reservation. The server cannot end a live provider session, so
 * it can only bill up to the reservation (above) and, when the client is seen running well past it, mark the
 * call abuse_flagged and refuse that user's next mint for VOICE_BLOCK_SECONDS. Once per call.
 */
async function flagOverrun(tx: Tx, s: OpenSession, now: Date): Promise<void> {
  const first = await tx.trainerSession.updateMany({ where: { id: s.id, abuseFlagged: false }, data: { abuseFlagged: true } });
  if (first.count === 0) return;
  await tx.user.update({ where: { id: s.userId }, data: { voiceBlockedUntil: new Date(now.getTime() + VOICE_BLOCK_SECONDS * 1000) } });
  await tx.auditEvent.create({
    data: { userId: s.userId, action: "usage.abuse_flagged", resource: s.id, metadata: { reservedMinutes: s.reservedMinutes, engineTier: s.engineTier } },
  });
}

function storedResult(s: OpenSession): CallResult {
  const connected = !!s.connectedAt || s.billableSeconds > 0;
  const gross = connected ? Math.ceil(s.billableSeconds / 60) : 0;
  const credited = Math.max(0, gross - s.billedMinutes);
  return {
    outcome: !connected ? "failed_connect" : credited > 0 ? "dropped_credited" : "billed",
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
 * Settles this user's calls that nobody ended: no heartbeat at all within the 15 minute connect window,
 * or silent for more than 30 seconds after the last one (rule 3). Runs lazily before a cap check or a usage read.
 * These calls are billed as if they ran until now, up to their reservation: the server cannot see the
 * provider connection, so silence is not treated as proof the call stopped.
 */
export async function settleStale(tx: Tx, userId: string, now: Date): Promise<void> {
  const open = await tx.trainerSession.findMany({ where: { userId, endedAt: null } });
  for (const s of open) {
    const silent = s.lastHeartbeatAt
      ? now.getTime() - s.lastHeartbeatAt.getTime() > HEARTBEAT_TIMEOUT_SECONDS * 1000
      : now.getTime() - s.createdAt.getTime() > CONNECT_WINDOW_SECONDS * 1000;
    if (silent) await settle(tx, s, "heartbeat_timeout", now);
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
  premiumVoice: { enabled: boolean; minutesCap: number; minutesUsed: number };
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
      premiumVoice: {
        enabled: r.premiumVoice,
        minutesCap: r.premiumVoice ? premiumVoiceCap(r.allowance.minutesCap) : 0,
        minutesUsed: r.allowance.premiumMinutesUsed,
      },
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, minutes: e.minutes, createdAt: e.createdAt.toISOString() })),
    };
  });
}

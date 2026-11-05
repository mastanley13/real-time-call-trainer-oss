import "server-only";
import type { Prisma, TrainerSession, UsageAllowance } from "@prisma/client";
import { prisma } from "./db";
import { billingActive, premiumOnSale } from "./serverConfig";
import { storedPlanEntitled } from "./subscriptionStatus";
import { premiumMinutesCapFor, premiumMinutesLeft } from "./premiumVoice";
import {
  CONNECT_WINDOW_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MAX_CALL_SECONDS, MAX_CONNECT_LAG_SECONDS, MAX_RESERVE_MINUTES,
  DAILY_SESSION_MINT_CAP, MIN_PREMIUM_SECONDS, OVERRUN_GRACE_SECONDS, PREMIUM_MINUTES_PER_UNIT, VOICE_BLOCK_SECONDS,
  capFor, effectivePlan, maxMinutesAfter, midCallCapApplies, periodFor, settleCall, splitAcrossBoundary,
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
 *
 * Free is the exception: its cap is checked only when a call starts. The reservation still stops two calls from
 * starting on the same last minutes, but it is not a limit on the running call: no heartbeat stop, no billing
 * clamp, no overrun flag. The call runs to its normal end (or the 24 hour length limit) and every minute it used
 * counts toward the month, which can leave minutesUsed above the cap. The next voice start is then refused.
 */

type Tx = Prisma.TransactionClient;

/**
 * Thrown when the allowance changed period under a settlement (a rollover committed between its read and its
 * write). The transaction rolls back and `runMetered` runs it again against the new period.
 */
export class StaleAllowanceError extends Error {
  constructor() { super("allowance changed period during settlement"); }
}

const TX_ATTEMPTS = 4;

async function runMetered<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn);
    } catch (e) {
      if (!(e instanceof StaleAllowanceError) || attempt >= TX_ATTEMPTS) throw e;
    }
  }
}

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
  /** Entitled to paid Premium right now: the allowance has Premium minutes this period (premiumMinutesCap above 0). */
  premiumVoice: boolean;
  /** The add-on flag is stored on the billing subject, entitled or not. Used to tell a fallback from "never bought". */
  premiumConfigured: boolean;
  /** PREMIUM_VOICE_ON_SALE is on (with billing). Off means no paid Premium at mint, whatever the subscription says. */
  premiumSaleOpen: boolean;
  /** Free members only: minutes already used this period from a Team pool that has ended. Counts against the cap. */
  usedElsewhere: number;
  /** Cap minus used: what the plan still has this period. */
  remaining: number;
  /** remaining minus what open calls have reserved: what a new call can take. */
  available: number;
}

/**
 * A past_due row with no recorded start (accounts that were past_due before pastDueSince existed) starts its grace
 * window now, and the start is saved so the window can run out without another webhook. The write is conditional
 * (still past_due, still no start), so a webhook that moved the status on in the meantime is never overwritten with a
 * stale timestamp. The row is then reloaded so the caller sees whatever won. Returns the effective row.
 */
async function stampPastDue<T extends { subscriptionStatus: string | null; pastDueSince: Date | null }>(
  db: Tx, kind: "user" | "organization", id: string, row: T, now: Date,
): Promise<T> {
  if (row.subscriptionStatus !== "past_due" || row.pastDueSince) return row;
  const where = { id, subscriptionStatus: "past_due", pastDueSince: null };
  const data = { pastDueSince: now };
  const select = { subscriptionStatus: true, pastDueSince: true } as const;
  if (kind === "user") await db.user.updateMany({ where, data });
  else await db.organization.updateMany({ where, data });
  const fresh = kind === "user" ? await db.user.findUnique({ where: { id }, select }) : await db.organization.findUnique({ where: { id }, select });
  return fresh ? { ...row, subscriptionStatus: fresh.subscriptionStatus, pastDueSince: fresh.pastDueSince } : row;
}

/**
 * The allowance row for a user or a Team pool, created on first use. Also the one place caps change:
 * it re-derives plan and cap from the owner's row (so a seat added, an upgrade or a downgrade lands
 * immediately) and rolls the period when the anchor date has passed. The anchor itself never moves,
 * and a plan change keeps minutesUsed; only a new period resets it, with no rollover.
 */

const PREMIUM_FIELDS = { premiumVoice: true, premiumVoiceQuantity: true, subscriptionPeriodEnd: true, premiumSuspendedAt: true } as const;

export async function ensureAllowance(db: Tx, subject: Subject, now: Date, depth = 0): Promise<UsageAllowance> {
  let plan: PlanTier;
  let cap: number;
  let premiumCap: number;
  let anchor: Date;
  let existing: UsageAllowance | null;
  if ("userId" in subject) {
    const loaded = await db.user.findUniqueOrThrow({ where: { id: subject.userId }, select: { planTier: true, subscriptionStatus: true, stripeSubscriptionId: true, pastDueSince: true, usageAnchorAt: true, ...PREMIUM_FIELDS } });
    const user = await stampPastDue(db, "user", subject.userId, loaded, now);
    plan = effectivePlan(storedPlanEntitled(user, now) ? user.planTier : "free", billingActive());
    cap = capFor(plan);
    // Read from the database on every resolve (so at every mint): the stricter Premium rule, no past_due grace, and
    // paid Premium only while PREMIUM_VOICE_ON_SALE is exactly "true". Comped Premium does not come through here.
    premiumCap = premiumOnSale() ? premiumMinutesCapFor(plan, user, now, 1, cap) : 0;
    anchor = user.usageAnchorAt;
    existing = await db.usageAllowance.findUnique({ where: { userId: subject.userId } });
  } else {
    const loadedOrg = await db.organization.findUniqueOrThrow({ where: { id: subject.organizationId }, select: { planTier: true, subscriptionStatus: true, stripeSubscriptionId: true, pastDueSince: true, seatCount: true, createdAt: true, ...PREMIUM_FIELDS } });
    const org = await stampPastDue(db, "organization", subject.organizationId, loadedOrg, now);
    plan = org.planTier === "team" && storedPlanEntitled(org, now) && billingActive() ? "team" : "free";
    cap = capFor(plan, org.seatCount);
    premiumCap = premiumOnSale() ? premiumMinutesCapFor(plan, org, now, org.seatCount, cap) : 0;
    anchor = org.createdAt;
    existing = await db.usageAllowance.findUnique({ where: { organizationId: subject.organizationId } });
  }
  const period = periodFor(anchor, now);
  if (!existing) {
    return db.usageAllowance.create({
      data: { ...subject, planTier: plan, minutesCap: cap, premiumMinutesCap: premiumCap, anchorAt: anchor, periodStart: period.start, periodEnd: period.end, minutesUsed: 0 },
    });
  }
  const data: Prisma.UsageAllowanceUpdateInput = {};
  if (existing.planTier !== plan) data.planTier = plan;
  if (existing.minutesCap !== cap) data.minutesCap = cap;
  if (existing.premiumMinutesCap !== premiumCap) data.premiumMinutesCap = premiumCap;
  if (existing.anchorAt.getTime() !== anchor.getTime()) data.anchorAt = anchor;
  // Periods only move forward: a caller whose clock reading is slightly behind a rollover that just committed
  // (a settlement retried after one) keeps the newer period instead of rolling it back.
  if (existing.periodStart.getTime() < period.start.getTime()) {
    // A new period starts clean, except that calls still open from the old one may run into it: each holds
    // the minutes it can still use here (its carry), so nothing else can take them before it settles.
    // Only one caller wins the swap on periodStart, so the carry is computed and written once.
    const carry = await openCarry(db, existing, period.start, cap, premiumCap);
    const won = await db.usageAllowance.updateMany({
      where: { id: existing.id, periodStart: existing.periodStart, version: existing.version },
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
    if (won.count === 0) {
      // Another writer got there first: a rollover (nothing left to do) or a settlement that changed the counters
      // this carry was computed from. Start again from what is stored now.
      if (depth >= 5) throw new StaleAllowanceError();
      return ensureAllowance(db, subject, now, depth + 1);
    }
    for (const c of carry.calls) await db.trainerSession.update({ where: { id: c.id }, data: { carriedMinutes: c.minutes, carriedPremiumMinutes: c.premium } });
    return db.usageAllowance.findUniqueOrThrow({ where: { id: existing.id } });
  }
  return Object.keys(data).length ? db.usageAllowance.update({ where: { id: existing.id }, data }) : existing;
}

/**
 * What each open call of this allowance holds in the period starting at `boundary`: the minutes it can still
 * use after that moment, taken in start order until the new cap (and the Premium limit) is used up.
 */
async function openCarry(db: Tx, existing: UsageAllowance, boundary: Date, cap: number, premiumCap: number) {
  const open = await db.trainerSession.findMany({ where: { allowanceId: existing.id, endedAt: null }, orderBy: { createdAt: "asc" } });
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
  const found = await db.user.findUnique({ where: { id: userId }, include: { organization: true } });
  if (!found) return null;
  const user = await stampPastDue(db, "user", userId, found, now);
  const org = found.organization ? await stampPastDue(db, "organization", found.organization.id, found.organization, now) : null;
  const pooled = !!org && org.planTier === "team" && storedPlanEntitled(org, now) && billingActive();
  const allowance = await ensureAllowance(db, pooled ? { organizationId: org.id } : { userId }, now);
  const plan: PlanTier = pooled ? "team" : effectivePlan(storedPlanEntitled(user, now) ? user.planTier : "free", billingActive());
  // A member whose Team ended (cancelled or unpaid) now has the Free allowance. Minutes they already used from the
  // pool this month still count against its cap, so leaving the pool is not a fresh 10 minutes.
  const usedElsewhere = !pooled && plan === "free" ? await usedInOtherAllowances(db, userId, allowance) : 0;
  const used = allowance.minutesUsed + usedElsewhere;
  return {
    allowance,
    pooled,
    plan,
    // Premium follows the stricter add-on rule ensureAllowance just applied from the database (active or trialing, add-on
    // quantity above 0, period end in the future): no Premium minutes this period means no Premium for the next call,
    // even while the base plan is still inside its past_due grace or the stored flag is still true.
    premiumVoice: allowance.premiumMinutesCap > 0,
    // The stored flag stays until the next webhook, so a lapsed plan with it still set is a fallback, not "never bought".
    premiumConfigured: pooled ? !!org.premiumVoice : !!user.premiumVoice,
    premiumSaleOpen: premiumOnSale(),
    usedElsewhere,
    remaining: roundMinutes(Math.max(0, allowance.minutesCap - used)),
    available: roundMinutes(Math.max(0, allowance.minutesCap - used - allowance.minutesReserved)),
  };
}

/**
 * Minutes this user used on any OTHER allowance (the Team pool they spent from before it ended) that fall inside the
 * current period of `allowance`. Calls on `allowance` itself are already in its minutesUsed, so nothing is counted twice.
 *
 * The ledger's createdAt is when a call was settled, not when it ran, and the pool's period and the member's own
 * period can start on different days. So each call is placed by when it actually ran: every call entry stores the
 * call's run interval (ranFrom to ranTo), and its minutes are shared out in proportion to how much of that interval
 * lies inside this period. A 10 minute call with 5 minutes after the member's reset counts 5 here, and a call that
 * ended before the reset counts 0. The calculation reads only the usage ledger, never TrainerSession: the retention
 * purge deletes call rows, and a purged call must not hand back minutes it already used.
 *
 * Entries with no run interval are counted at their createdAt: support credits (not calls, so they count when they
 * were given) and call entries from before the interval was stored whose call row was already gone at backfill.
 */
async function usedInOtherAllowances(db: Tx, userId: string, allowance: UsageAllowance): Promise<number> {
  const periodStartMs = allowance.periodStart.getTime();
  const periodEndMs = allowance.periodEnd.getTime();
  let total = 0;
  // Calls: any entry whose call was still running at or after the start of the period.
  const timed = await db.usageEntry.findMany({ where: { userId, ranTo: { gte: allowance.periodStart } } });
  for (const e of timed) {
    if (e.allowanceId === allowance.id || !e.ranFrom || !e.ranTo) continue;
    const fromMs = e.ranFrom.getTime();
    const ranMs = e.ranTo.getTime() - fromMs;
    if (ranMs <= 0) continue;
    const insideMs = Math.max(0, Math.min(e.ranTo.getTime(), periodEndMs) - Math.max(fromMs, periodStartMs));
    total += e.minutes * Math.min(1, insideMs / ranMs);
  }
  // Everything without a run interval, by the date it was written.
  const untimed = await db.usageEntry.findMany({ where: { userId, createdAt: { gte: allowance.periodStart } } });
  for (const e of untimed) {
    if (e.allowanceId !== allowance.id && !e.ranFrom && !e.ranTo) total += e.minutes;
  }
  return roundMinutes(Math.max(0, total));
}

/** Usage can be a half minute (a support credit), so remaining is kept clear of floating point dust. */
const roundMinutes = (n: number) => Math.round(n * 100) / 100;

/**
 * The cap check (rule 11), the same for every plan: any minutes left let a call start, even half of one. What the
 * screen shows as "0.5 voice minutes left" is what this enforces. 9.5 of 10 used starts, 10 or more does not.
 * A Free call then runs to its end. A Pro or Team call holds a whole minute, because reservations are whole minutes
 * and every started minute counts, so it can end at most half a minute over its plan.
 */
export function checkCap(r: Pick<Resolved, "remaining">): { ok: true } | { ok: false; error: "cap_reached" } {
  return r.remaining > 0 ? { ok: true } : { ok: false, error: "cap_reached" };
}

// ---- Voice engine -----------------------------------------------------------------------------

export type VoiceEngine = "premium" | "standard";

/**
 * Which engine the NEXT minted session uses, and how many Premium minutes it holds. Premium needs the add-on entitlement
 * (premiumMinutesCap above 0, re-derived from the database at this mint) and at least one whole Premium minute
 * (MIN_PREMIUM_SECONDS) not used and not held by open calls, so concurrent calls cannot all pick Premium. A premium call
 * holds at most what is left (up to its own reservation). beginCall makes that the call's whole reservation, so its
 * maxSeconds is min(the normal call allowance, the Premium seconds left): the provider session cannot change engine
 * mid-call, and the call is never moved onto another model.
 */
export function chooseEngine(
  r: Pick<Resolved, "premiumVoice"> & { allowance: Pick<UsageAllowance, "premiumMinutesCap" | "premiumMinutesUsed" | "premiumMinutesReserved"> },
  reserve: number,
): { engine: VoiceEngine; premiumMinutes: number } {
  if (!r.premiumVoice) return { engine: "standard", premiumMinutes: 0 };
  const left = premiumMinutesLeft(r.allowance);
  return left * 60 >= MIN_PREMIUM_SECONDS ? { engine: "premium", premiumMinutes: Math.min(reserve, left) } : { engine: "standard", premiumMinutes: 0 };
}

/** What the mint tells the caller about Premium for this call. No model ids. */
export interface PremiumMintInfo {
  /** Why this call runs Premium: the paid add-on, a comped organization, or neither (null = Standard). */
  source: "paid" | "comped" | null;
  /** Premium minutes this billing subject has this period (0 without the add-on). */
  cap: number;
  /** Whole paid Premium minutes left for later calls once this call's hold is taken. */
  leftAfter: number;
  /**
   * The add-on is on the account but this call started on Standard: its minutes are used, billing is not in good
   * standing, or Premium is not on sale (PREMIUM_VOICE_ON_SALE off).
   */
  fallback: "minutes_used" | "not_entitled" | "not_on_sale" | null;
  /** This call is Premium on the paid add-on and holds the last Premium minutes: the next call will be Standard. */
  nextCallStandard: boolean;
}

/** Pure: the Premium summary for a call minted with `engine`, given what the allowance had before the hold. */
export function premiumMintInfo(
  r: Pick<Resolved, "premiumVoice" | "premiumConfigured"> & Partial<Pick<Resolved, "premiumSaleOpen">> & { allowance: Pick<UsageAllowance, "premiumMinutesCap" | "premiumMinutesUsed" | "premiumMinutesReserved"> },
  engine: VoiceEngine, premiumMinutes: number, comped: boolean,
): PremiumMintInfo {
  const left = premiumMinutesLeft(r.allowance);
  const cap = r.allowance.premiumMinutesCap;
  if (comped) return { source: "comped", cap, leftAfter: left, fallback: null, nextCallStandard: false };
  if (engine === "premium" && premiumMinutes > 0) {
    const leftAfter = Math.max(0, left - premiumMinutes);
    return { source: "paid", cap, leftAfter, fallback: null, nextCallStandard: leftAfter * 60 < MIN_PREMIUM_SECONDS };
  }
  const fallback = r.premiumVoice ? "minutes_used" : !r.premiumConfigured ? null : r.premiumSaleOpen === false ? "not_on_sale" : "not_entitled";
  return { source: null, cap, leftAfter: left, fallback, nextCallStandard: false };
}

// ---- Starting a call --------------------------------------------------------------------------

export interface ScenarioInfo { id: string; title?: string; industry?: string; difficulty?: string }

export type BeginResult =
  | { ok: true; callId: string; remaining: number; pooled: boolean; engine: VoiceEngine; maxSeconds: number; premium: PremiumMintInfo }
  | { ok: false; error: "cap_reached" | "minutes_reserved" | "no_organization" | "user_not_found" | "standard_unavailable" | "daily_session_limit" }
  | { ok: false; error: "voice_blocked"; retryAfterSeconds: number };

const RESERVE_ATTEMPTS = 5;

/**
 * Cap check, reservation, then the TrainerSession that every later metering write is keyed by. Call before
 * minting a provider session. A user who already minted DAILY_SESSION_MINT_CAP voice sessions in the last 24 hours
 * gets `daily_session_limit`. The reservation is what the call may use at most (`maxSeconds`), and it is
 * taken with a compare-and-swap on the allowance row, so two calls (or two Team members) cannot reserve
 * the same minutes. The Premium minutes are reserved in the same swap, so concurrent mints cannot both spend the last
 * of them. `standardAvailable: false` means the server has no standard engine configured: a call that is not entitled
 * to Premium is then refused rather than run on Premium for free. `compedPremium: true` (a comped organization on the
 * Premium tier, read from the database by the mint route) runs Premium without drawing on the paid Premium minutes:
 * comped overrides billing, so its call stays on the standard billing engine, keeps the normal reservation and is never
 * clamped to Premium minutes; the mint route picks the Premium model for it.
 */
export async function beginCall(userId: string, scenario: ScenarioInfo, now = new Date(), opts: { standardAvailable?: boolean; compedPremium?: boolean } = {}): Promise<BeginResult> {
  return runMetered(async (tx) => {
    await settleStale(tx, userId, now);
    const user = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true, voiceBlockedUntil: true } });
    if (!user) return { ok: false, error: "user_not_found" } as const;
    if (user.voiceBlockedUntil && user.voiceBlockedUntil.getTime() > now.getTime()) {
      return { ok: false, error: "voice_blocked", retryAfterSeconds: Math.ceil((user.voiceBlockedUntil.getTime() - now.getTime()) / 1000) } as const;
    }
    // Per-user daily mint cap on the server clock. Only voice sessions count (they carry an allowance; saved text
    // transcripts do not). Mints that fail upstream count too, so retrying a failing mint cannot dodge the cap.    // The user row is locked until this transaction commits, so concurrent mints for one user run one after the
    // other: each sees the sessions the earlier ones created and the cap cannot be overshot.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const minted = await tx.trainerSession.count({
      where: { userId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) }, allowanceId: { not: null } },
    });
    if (minted >= DAILY_SESSION_MINT_CAP) return { ok: false, error: "daily_session_limit" } as const;
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const r = await resolveAllowance(tx, userId, now);
      if (!r) return { ok: false, error: "user_not_found" } as const;
      const check = checkCap(r);
      if (!check.ok) return check;
      if (!user.organizationId) return { ok: false, error: "no_organization" } as const;
      const capApplies = midCallCapApplies(r.plan);
      // Any minutes not held by another start let this one begin, on every plan.
      if (r.available <= 0) return { ok: false, error: "minutes_reserved" } as const;

      // Reservations are whole minutes and round up: a call holds at least one so a second start cannot take the same
      // last minutes, even if that holds up to half a minute more than is left.
      const wanted = Math.min(Math.max(1, Math.ceil(r.available)), MAX_RESERVE_MINUTES);
      const comped = opts.compedPremium === true;
      // Comped overrides billing: the call runs the Premium model (the route decides that) on the standard billing
      // engine, holds no paid Premium minutes and keeps the normal reservation. engineTier stays the billing engine.
      const { engine, premiumMinutes } = comped ? { engine: "standard" as const, premiumMinutes: 0 } : chooseEngine(r, wanted);
      // A paid Premium call may use only the Premium minutes it holds, so that share is its reservation (and maxSeconds):
      // min(the normal call allowance, the Premium minutes left).
      const reserve = engine === "premium" ? premiumMinutes : wanted;
      if (engine === "standard" && opts.standardAvailable === false) return { ok: false, error: "standard_unavailable" } as const;
      const premium = premiumMintInfo(r, engine, premiumMinutes, comped);
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
          // The tier the call runs on, durable from the start: comped or paid Premium is premium, else standard.
          // The realtime mint route confirms it with the model it actually minted (src/lib/voiceMintLog.ts).
          voiceTier: comped || engine === "premium" ? "premium" : "standard",
          capEnforced: capApplies,
        },
      });
      // Free calls are not limited by the plan cap once started, only by the call length limit.
      const maxSeconds = capApplies ? reserve * 60 : MAX_CALL_SECONDS;
      return { ok: true, callId: session.id, remaining: r.remaining, pooled: r.pooled, engine, maxSeconds, premium } as const;
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

/**
 * True when the call is still alive, as far as the server can tell, well past the end of its limit:
 * `now` is beyond the billing start plus the call's maximum length plus the grace period. For a call the plan
 * cap applies to, that length is its reservation; for a Free call it is the 24 hour length limit.
 */
function pastReservation(s: Pick<OpenSession, "createdAt" | "connectedAt" | "reservedMinutes" | "allowanceId">, now: Date, capApplies: boolean): boolean {
  if (!s.allowanceId) return false;
  const end = billingStart(s).getTime() + maxSecondsOf(s.reservedMinutes, capApplies) * 1000;
  return now.getTime() - end > OVERRUN_GRACE_SECONDS * 1000;
}

/**
 * Whether the plan cap limits this running call: the rule it was started under, stored on the call at mint.
 * A plan change mid-call does not change it. Calls from before the column existed default to capped.
 */
const callCapApplies = (s: Pick<OpenSession, "capEnforced">): boolean => s.capEnforced !== false;

/** End reasons of a call the server settled: the reservation clamped it, or nobody reported its end. */
const SERVER_ENDED: ReadonlySet<string> = new Set(["cap_reached", "max_duration", "heartbeat_timeout"]);

/**
 * The most seconds this call may run: what it reserved at mint time, and never more than the 24 hour limit.
 * A call the plan cap does not apply to (Free) has only the 24 hour limit.
 */
const maxSecondsOf = (reservedMinutes: number, capApplies = true) => (capApplies ? Math.min(reservedMinutes * 60, MAX_CALL_SECONDS) : MAX_CALL_SECONDS);

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
  return runMetered(async (tx) => {
    const s = await tx.trainerSession.findUnique({ where: { id: callId } });
    if (!s || s.userId !== userId) return { found: false } as const;
    if (s.endedAt) {
      // The server already settled this call. Still heartbeating well past the end of its reservation means the
      // browser kept the provider session running, whether the server clamped it or reaped it as silent.
      if (SERVER_ENDED.has(s.endReason ?? "") && pastReservation(s, now, callCapApplies(s))) await flagOverrun(tx, s, now);
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

    const { limit, capApplies } = await limitSeconds(tx, s, now);
    const start = billingStart({ createdAt: s.createdAt, connectedAt });
    const elapsed = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
    const left = Math.min(limit, MAX_CALL_SECONDS) - elapsed;
    if (left > 0) return { found: true, stop: false, secondsLeft: left } as const;
    // A Free call can only be stopped by the call length limit, never by the plan cap.
    const reason = capApplies && limit - elapsed <= 0 ? "cap_reached" : "max_duration";
    const settlement = await settle(tx, { ...s, connectedAt, lastHeartbeatAt: now, degradedAt: null }, reason, now);
    return { found: true, stop: true, reason, settlement } as const;
  });
}

/**
 * Seconds a call may run in total, and whether the plan cap is what sets that. A call from before reservations
 * existed uses what the allowance has left. Free calls get only the 24 hour call length limit.
 */
async function limitSeconds(tx: Tx, s: OpenSession, now: Date): Promise<{ limit: number; capApplies: boolean }> {
  const capApplies = callCapApplies(s);
  if (!capApplies) return { limit: MAX_CALL_SECONDS, capApplies };
  if (s.allowanceId) return { limit: maxSecondsOf(s.reservedMinutes), capApplies };
  const r = await resolveAllowance(tx, s.userId, now);
  return { limit: (r?.remaining ?? 0) * 60, capApplies };
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

/** End reasons that can earn a dropped-call credit; a credited call is one of these with 0 billed minutes. */
const DROP_REASONS: CallEndReasonId[] = ["network_drop", "provider_error", "server_error"];
/** End reasons that use up the daily free allowance (DAILY_DROP_CREDIT_CAP) when they bill 0 minutes. */
const UNCHARGED_REASONS: CallEndReasonId[] = [...DROP_REASONS, "failed_connect"];

/** `serverMintFailure`: set only by the mint routes, never from a request body (see /api/usage/end's reason enum). */
interface SettleOpts { serverMintFailure?: boolean }

async function settle(tx: Tx, original: OpenSession, requested: CallEndReasonId, now: Date, opts: SettleOpts = {}): Promise<CallResult | null> {
  const target = await chargeTarget(tx, original, now);
  if (!target) return null;
  const { allowance, samePeriod } = target;
  const s: OpenSession = { ...original, carriedMinutes: target.call.carriedMinutes, carriedPremiumMinutes: target.call.carriedPremiumMinutes };

  const start = billingStart(s);
  const naturalEnd = endedAtFor(s, requested, now, start);
  // Connected means the client said so, or the call outlived the connect cutoff and so must have run.
  // A mint the server itself failed never connected, however long the provider took to fail: no 60 s cutoff applies.
  const connected = !!s.connectedAt || (!opts.serverMintFailure && naturalEnd.getTime() > start.getTime());
  const reason: CallEndReasonId = connected ? requested : "failed_connect";

  // The reservation limits what a capped call (Pro, Team) is billed. A Free call is billed for every minute it ran.
  const bounded = callCapApplies(s);
  // A Free call reaped as silent keeps everything it was confirmed to have used: its time is counted through the last
  // heartbeat the server saw. Only the silent stretch after that is bounded, by the call's reservation, because the
  // server cannot tell how long a silent call really ran and must not bill a closed browser tab for a day.
  let billedEnd = naturalEnd;
  if (!bounded && requested === "heartbeat_timeout") {
    const confirmedMs = Math.max(start.getTime(), s.lastHeartbeatAt?.getTime() ?? 0);
    billedEnd = new Date(Math.min(naturalEnd.getTime(), confirmedMs + s.reservedMinutes * 60 * 1000));
  }
  const endedAt = connected ? billedEnd : now;
  // The connect heartbeat sets lastHeartbeatAt to the start itself, so only a later one proves the client kept running.
  const heartbeatSeen = !!s.lastHeartbeatAt && s.lastHeartbeatAt.getTime() > start.getTime();
  // Only a call that could still go uncharged needs the 24 hour count. The user row is locked first, so two of this
  // user's calls settle one after the other and the second sees the first one's credit. An uncharged call is a drop
  // reason or a never-connected call (failed_connect) with 0 billed minutes, zero-second calls included: every other
  // client-reported failure bills at least 1. A mint failure the server itself reports is not the client's doing: it
  // skips the count, so it is never charged. Nothing stored marks such a row, so later calls still count it.
  let recentCreditedDrops = 0;
  const neverConnected = !connected && !opts.serverMintFailure;
  if (neverConnected || (connected && !heartbeatSeen && DROP_REASONS.includes(reason))) {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${s.userId} FOR UPDATE`;
    recentCreditedDrops = await tx.trainerSession.count({
      where: {
        userId: s.userId,
        endedAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        endReason: { in: UNCHARGED_REASONS },
        billedMinutes: 0,
      },
    });
  }
  const st = settleCall({ connectedAt: connected ? start : null, endedAt, reason, remainingMinutes: bounded ? target.remaining : Number.POSITIVE_INFINITY, heartbeatSeen, recentCreditedDrops });
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
    const newGross = inCurrent ? (bounded ? Math.min(split.newMinutes, s.carriedMinutes) : split.newMinutes) : 0;
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
  // The heartbeat the credit decision saw must still be the latest: a heartbeat that committed since the read
  // means this call was not a drop, so the settlement is redone from the fresh row.
  const won = await tx.trainerSession.updateMany({
    where: { id: s.id, endedAt: null, lastHeartbeatAt: s.lastHeartbeatAt ?? null },
    data: { endedAt, endReason: b.endReason, billableSeconds: b.billableSeconds, billedMinutes: b.net + b.priorNet },
  });
  if (won.count === 0) {
    const current = await tx.trainerSession.findUnique({ where: { id: s.id }, select: { endedAt: true } });
    if (current && !current.endedAt) throw new StaleAllowanceError();
    return null;
  }

  // When the call really ran, written on every call entry so it outlives the TrainerSession row (see usedInOtherAllowances).
  const ran = b.billableSeconds > 0 ? { ranFrom: start, ranTo: new Date(start.getTime() + b.billableSeconds * 1000) } : {};
  if (b.gross > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "voice_call", minutes: b.gross, ...ran } });
  }
  if (b.credit > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "credit_drop", minutes: -b.credit, ...ran } });
  }
  if (b.priorNet > 0) {
    await tx.usageEntry.create({ data: { userId: s.userId, allowanceId: allowance.id, trainerSessionId: s.id, kind: "voice_call_prior", minutes: b.priorNet, createdAt: b.priorAt, ...ran } });
  }
  // Release the reservation and book the minutes in one atomic update; increments never read a stale value.
  if (b.net > 0 || b.releaseMinutes > 0 || b.releasePremium > 0) {
    // Guarded on the period this settlement was worked out for. A rollover that committed since reset the counters
    // and reserved a carry for this call, so writing now would charge old-period minutes to the new period.
    const booked = await tx.usageAllowance.updateMany({
      where: { id: allowance.id, periodStart: allowance.periodStart },
      data: {
        minutesUsed: { increment: b.net },
        minutesReserved: { decrement: b.releaseMinutes },
        premiumMinutesUsed: { increment: b.premiumNet },
        premiumMinutesReserved: { decrement: b.releasePremium },
        version: { increment: 1 },
      },
    });
    if (booked.count === 0) throw new StaleAllowanceError();
  }
  // A client that reports the end long after the reservation ran out kept the provider session open.
  // A silent call reaped after its reservation ran out counts too: the server cannot tell it from a live one.
  if (connected && hasReservation && SERVER_ENDED.has(b.endReason) && pastReservation({ ...s, connectedAt: start }, now, callCapApplies(s))) {
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
export async function endCall(userId: string, callId: string, reason: CallEndReasonId, now = new Date(), opts: SettleOpts = {}): Promise<CallResult | null> {
  return runMetered(async (tx) => {
    const s = await tx.trainerSession.findUnique({ where: { id: callId } });
    if (!s || s.userId !== userId) return null;
    if (s.endedAt) {
      // An end event for a call the server already settled, arriving after its reservation ran out.
      if (SERVER_ENDED.has(s.endReason ?? "") && pastReservation(s, now, callCapApplies(s))) await flagOverrun(tx, s, now);
      return storedResult(s);
    }
    const done = await settle(tx, s, reason, now, opts);
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
  /**
   * Paid Premium Voice for this billing subject, from the allowance re-derived just now. `remaining` is whole minutes
   * not used and not held by open calls; `units` is minutesCap / 40 (Team: min(add-on quantity, seats)).
   */
  premiumVoice: { enabled: boolean; configured: boolean; minutesCap: number; minutesUsed: number; remaining: number; units: number };
  entries: { id: string; kind: string; minutes: number; createdAt: string }[];
}

/** What the usage panel shows. Everything comes from the allowance row and this user's ledger entries. */
export async function usageSummary(userId: string, now = new Date()): Promise<UsageSummary | null> {
  return runMetered(async (tx) => {
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
      minutesUsed: roundMinutes(r.allowance.minutesUsed + r.usedElsewhere),
      remaining: r.remaining,
      periodStart: r.allowance.periodStart.toISOString(),
      periodEnd: r.allowance.periodEnd.toISOString(),
      premiumVoice: {
        enabled: r.premiumVoice,
        configured: r.premiumConfigured,
        minutesCap: r.allowance.premiumMinutesCap,
        minutesUsed: r.allowance.premiumMinutesUsed,
        remaining: premiumMinutesLeft(r.allowance),
        units: Math.floor(r.allowance.premiumMinutesCap / PREMIUM_MINUTES_PER_UNIT),
      },
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, minutes: e.minutes, createdAt: e.createdAt.toISOString() })),
    };
  });
}

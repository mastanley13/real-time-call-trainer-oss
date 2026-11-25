import "server-only";
import { randomBytes } from "node:crypto";
import type { CompetitionEntry } from "@prisma/client";
import { prisma } from "./db";
import { settleStaleCompetition } from "./usage";
import { CONNECT_WINDOW_SECONDS, HEARTBEAT_TIMEOUT_SECONDS, MAX_CONNECT_LAG_SECONDS } from "./usagePlan";
import {
  COMPETITION_TRACKS, COMPETITION_MAX_ATTEMPTS, COMPETITION_CALL_MAX_SECONDS,
  COMPETITION_MIN_DURATION_SECONDS, COMPETITION_MIN_TRAINEE_TURNS,
  COMPETITION_DEFAULT_SEASON, COMPETITION_DEFAULT_TITLE, COMPETITION_DEFAULT_MAX_TOTAL_CALLS,
  competitionPhase, competitionTrackBySlug, compareLeaderboardRows, defaultDisplayName,
  sanitizeDisplayName, sanitizeTeamLabel, validateCompetitionSubmission,
  type CompetitionTrackSlug, type CompetitionStatusResponse, type CompetitionShareCardData,
  type CompetitionFinalizeResult, type CompetitionLeaderboardRow, type CompetitionUserEntry,
} from "./competition";

const consumed = ["minted", "completed", "abandoned"];
const safeDefaultName = (user: Parameters<typeof defaultDisplayName>[0]) => {
  const name = defaultDisplayName(user);
  return name.includes("@") ? "Competitor" : name;
};
const date = (value?: string) => {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
};

export function competitionConfig(env = process.env, now = new Date()) {
  const demoMode = env.DEMO_MODE === "true" || !env.DATABASE_URL;
  const enabled = demoMode || env.COMPETITION_ENABLED === "true";
  const day = 86_400_000;
  const today = Math.floor(now.getTime() / day) * day;
  const startAt = demoMode ? new Date(today - 5 * day) : date(env.COMPETITION_START_AT);
  const endAt = demoMode ? new Date(today + 25 * day) : date(env.COMPETITION_END_AT);
  const cap = Number(env.COMPETITION_MAX_TOTAL_CALLS);
  return {
    slug: env.COMPETITION_SLUG || COMPETITION_DEFAULT_SEASON,
    title: env.COMPETITION_TITLE || COMPETITION_DEFAULT_TITLE,
    enabled, demoMode, startAt, endAt, phase: competitionPhase({ enabled, startAt, endAt }, now),
    maxTotalCalls: Number.isSafeInteger(cap) && cap > 0 ? cap : COMPETITION_DEFAULT_MAX_TOTAL_CALLS,
  };
}

type Ranked = CompetitionEntry & { overallScore: number; completedAt: Date };
function qualified(rows: CompetitionEntry[]): Ranked[] {
  return rows.filter((r): r is Ranked => r.status === "completed" && r.overallScore !== null && r.completedAt !== null && !!competitionTrackBySlug(r.trackSlug));
}
function rank(rows: Ranked[], track?: string | null): Ranked[] {
  const seen = new Set<string>();
  return rows.filter((r) => !track || r.trackSlug === track)
    .sort((a, b) => compareLeaderboardRows({ ...a, goalAchieved: !!a.goalAchieved }, { ...b, goalAchieved: !!b.goalAchieved }) || a.id.localeCompare(b.id))
    .filter((r) => { if (seen.has(r.userId)) return false; seen.add(r.userId); return true; });
}
function rankOf(rows: Ranked[], userId: string, track?: string): number | null {
  const index = rank(rows, track).findIndex((r) => r.userId === userId);
  return index < 0 ? null : index + 1;
}

const demoNames = ["Avery Quill", "Rowan Finch", "Tess Wren", "Jules Moss", "Kai Linden", "Mara Vale", "Remy Slate"];
function demoEntries(cfg: ReturnType<typeof competitionConfig>): Ranked[] {
  return COMPETITION_TRACKS.map((track, i) => {
    const completedAt = new Date((cfg.startAt?.getTime() ?? Date.UTC(2026, 10, 20)) + (i + 1) * 3_600_000);
    return {
      id: "demo-" + track.slug, userId: "demo-person-" + i, seasonSlug: cfg.slug, trainerSessionId: null,
      trackSlug: track.slug, scenarioId: track.scenarioId, attemptNumber: 1, status: "completed",
      displayName: demoNames[i], teamLabel: null, overallScore: 96 - i * 3, grade: i < 3 ? "A" : "B",
      goalAchieved: i < 6, durationSeconds: 180 + i * 15, shareToken: "demo-" + track.slug,
      createdAt: completedAt, completedAt, updatedAt: completedAt,
    };
  });
}
async function seasonRows(seasonSlug: string): Promise<Ranked[]> {
  return qualified(await prisma.competitionEntry.findMany({ where: { seasonSlug, status: "completed", overallScore: { not: null } } }));
}
function publicRow(row: Ranked, index: number, userId?: string | null): CompetitionLeaderboardRow {
  const track = competitionTrackBySlug(row.trackSlug)!;
  return {
    rank: index + 1, entryId: row.id, displayName: row.displayName, teamLabel: row.teamLabel,
    trackSlug: track.slug, trackLabel: track.label, overallScore: row.overallScore, grade: row.grade ?? "",
    goalAchieved: !!row.goalAchieved, completedAt: row.completedAt.toISOString(), shareToken: row.shareToken,
    isCurrentUser: row.userId === userId,
  };
}
function userEntry(row: CompetitionEntry): CompetitionUserEntry {
  const track = competitionTrackBySlug(row.trackSlug)!;
  return {
    id: row.id, attemptNumber: row.attemptNumber ?? 0, trackSlug: track.slug, trackLabel: track.label,
    scenarioId: row.scenarioId, status: row.status as CompetitionUserEntry["status"], overallScore: row.overallScore,
    grade: row.grade, goalAchieved: row.goalAchieved, durationSeconds: row.durationSeconds, shareToken: row.shareToken,
    trainerSessionId: row.trainerSessionId, createdAt: row.createdAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function getCompetitionStatus(opts: { userId?: string | null; track?: CompetitionTrackSlug | null; limit?: number } = {}): Promise<CompetitionStatusResponse> {
  const cfg = competitionConfig();
  const rows = cfg.demoMode ? demoEntries(cfg) : await seasonRows(cfg.slug);
  const globalCallsUsed = cfg.demoMode ? rows.length : await prisma.competitionEntry.count({ where: { seasonSlug: cfg.slug, status: { in: consumed } } });
  const user = !cfg.demoMode && opts.userId ? await prisma.user.findUnique({ where: { id: opts.userId }, select: { firstName: true, lastName: true, email: true } }) : null;
  const entries = user && opts.userId ? await prisma.competitionEntry.findMany({ where: { seasonSlug: cfg.slug, userId: opts.userId }, orderBy: { createdAt: "desc" } }) : [];
  const attemptsUsed = entries.filter((r) => consumed.includes(r.status)).length;
  const best = rank(rows).find((r) => r.userId === opts.userId);
  return {
    season: { slug: cfg.slug, title: cfg.title, enabled: cfg.enabled, phase: cfg.phase,
      startAt: cfg.startAt?.toISOString() ?? null, endAt: cfg.endAt?.toISOString() ?? null,
      maxAttempts: COMPETITION_MAX_ATTEMPTS, maxCallSeconds: COMPETITION_CALL_MAX_SECONDS,
      minDurationSeconds: COMPETITION_MIN_DURATION_SECONDS, minTraineeTurns: COMPETITION_MIN_TRAINEE_TURNS,
      demoMode: cfg.demoMode, globalCallsUsed, globalCallsCap: cfg.maxTotalCalls },
    tracks: COMPETITION_TRACKS, leaderboard: rank(rows, opts.track).slice(0, Math.max(0, Math.min(opts.limit ?? 100, 100))).map((r, i) => publicRow(r, i, opts.userId)),
    totalQualifiedEntries: rows.length,
    viewer: { authenticated: !!user, displayName: entries[0]?.displayName ?? (user ? safeDefaultName(user) : null),
      teamLabel: entries[0]?.teamLabel ?? null, attemptsUsed, attemptsRemaining: Math.max(0, COMPETITION_MAX_ATTEMPTS - attemptsUsed),
      bestScore: best?.overallScore ?? null, overallRank: opts.userId ? rankOf(rows, opts.userId) : null,
      entries: entries.filter((r) => !!competitionTrackBySlug(r.trackSlug)).map(userEntry) },
  };
}

export async function getCompetitionShareCard(token: string): Promise<CompetitionShareCardData | null> {
  const cfg = competitionConfig();
  const demos = demoEntries(cfg);
  const demo = demos.find((r) => r.shareToken === token);
  const found = demo ?? (cfg.demoMode ? null : await prisma.competitionEntry.findUnique({ where: { shareToken: token } }));
  if (!found) return null;
  const row = qualified([found])[0];
  if (!row) return null;
  const track = competitionTrackBySlug(row.trackSlug)!;
  const rows = demo ? demos : await seasonRows(row.seasonSlug);
  return { shareToken: row.shareToken, seasonSlug: row.seasonSlug, seasonTitle: cfg.title,
    displayName: row.displayName, teamLabel: row.teamLabel, trackSlug: track.slug, trackLabel: track.label,
    buyerName: track.buyerName, overallScore: row.overallScore, grade: row.grade ?? "", goalAchieved: !!row.goalAchieved,
    overallRank: rankOf(rows, row.userId)!, industryRank: rankOf(rows, row.userId, row.trackSlug)!,
    totalEntries: rows.length, completedAt: row.completedAt.toISOString(), demoMode: !!demo };
}

type ClaimError = "competition_inactive" | "competition_full" | "call_in_progress" | "attempts_exhausted";
type ClaimResult = { ok: true; entry: CompetitionEntry } | { ok: false; error: ClaimError };
export async function claimCompetitionAttempt(input: { userId: string; trackSlug: CompetitionTrackSlug; now?: Date }): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const cfg = competitionConfig(process.env, now);
  const track = competitionTrackBySlug(input.trackSlug);
  if (cfg.demoMode || !track) return { ok: false, error: "competition_inactive" };
  return prisma.$transaction(async (tx) => {
    // One season-wide lock serializes the global allowance and per-account slots.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${"competition:" + cfg.slug}::text))`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
    await settleStaleCompetition(tx, input.userId, now, { reclaimNeverConnected: true });
    const where = { seasonSlug: cfg.slug, userId: input.userId };
    // Recover claims interrupted before a session could be attached, after the full connect window.
    await tx.competitionEntry.updateMany({ where: { ...where, status: "minted", trainerSessionId: null, createdAt: { lt: new Date(now.getTime() - CONNECT_WINDOW_SECONDS * 1000) } }, data: { status: "refunded", attemptNumber: null } });
    if (cfg.phase !== "active") return { ok: false, error: "competition_inactive" };
    const global = await tx.competitionEntry.count({ where: { seasonSlug: cfg.slug, status: { in: consumed } } });
    if (global >= cfg.maxTotalCalls) return { ok: false, error: "competition_full" };
    const entries = await tx.competitionEntry.findMany({ where, orderBy: { createdAt: "desc" }, include: { trainerSession: { select: { endedAt: true } } } });
    for (const entry of entries) {
      // A connected call ended without a save. Starting another call consumes it as abandoned.
      if (entry.status !== "minted") continue;
      if (!entry.trainerSession?.endedAt) return { ok: false, error: "call_in_progress" };
      await tx.competitionEntry.updateMany({ where: { id: entry.id, status: "minted" }, data: { status: "abandoned", completedAt: now } });
    }
    const used = entries.filter((r) => consumed.includes(r.status));
    if (used.length >= COMPETITION_MAX_ATTEMPTS) return { ok: false, error: "attempts_exhausted" };
    const attemptNumber = [1, 2, 3].find((n) => !used.some((r) => r.attemptNumber === n))!;
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId } });
    const entry = await tx.competitionEntry.create({ data: {
      ...where, scenarioId: track.scenarioId, trackSlug: track.slug, attemptNumber, status: "minted",
      displayName: entries[0]?.displayName ?? safeDefaultName(user), teamLabel: entries[0]?.teamLabel ?? null,
      shareToken: randomBytes(9).toString("base64url"), createdAt: now,
    } });
    return { ok: true, entry };
  });
}

export async function attachSessionToCompetitionEntry(entryId: string, trainerSessionId: string) {
  const result = await prisma.competitionEntry.updateMany({ where: { id: entryId, status: "minted", trainerSessionId: null }, data: { trainerSessionId } });
  if (result.count !== 1) throw new Error("Competition claim is no longer open");
}
export async function refundCompetitionEntry(entryId: string) {
  return prisma.competitionEntry.updateMany({ where: { id: entryId, status: "minted" }, data: { status: "refunded", attemptNumber: null } });
}

async function resultFor(row: CompetitionEntry): Promise<CompetitionFinalizeResult> {
  const track = competitionTrackBySlug(row.trackSlug)!;
  const rows = row.status === "completed" ? await seasonRows(row.seasonSlug) : [];
  return { entryId: row.id, attemptNumber: row.attemptNumber ?? 0, trackSlug: track.slug, trackLabel: track.label,
    qualified: row.status === "completed", overallScore: row.overallScore, grade: row.grade,
    overallRank: rankOf(rows, row.userId), industryRank: rankOf(rows, row.userId, track.slug), shareToken: row.shareToken };
}

export async function finalizeCompetitionEntry(input: { userId: string; trainerSessionId: string; durationSeconds: number; transcript: Array<{ role: string; text: string }>; evaluation?: Record<string, unknown>; graded: boolean }): Promise<CompetitionFinalizeResult | null> {
  const row = await prisma.competitionEntry.findFirst({ where: { trainerSessionId: input.trainerSessionId, userId: input.userId, status: "minted" }, include: { trainerSession: true } });
  if (!row?.trainerSession || !row.trainerSession.isCompetition || row.trainerSession.userId !== input.userId) return null;
  const s = row.trainerSession;
  const now = new Date();
  const start = Math.min(s.connectedAt?.getTime() ?? Infinity, s.createdAt.getTime() + MAX_CONNECT_LAG_SECONDS * 1000);
  // The end event and save can arrive in either order. An active heartbeat lets the server
  // use its current clock, but not an unbounded interval after the last sign of connection.
  const lastSeen = (s.lastHeartbeatAt ?? s.connectedAt)?.getTime() ?? 0;
  const end = s.endedAt?.getTime() ?? Math.min(now.getTime(), lastSeen + HEARTBEAT_TIMEOUT_SECONDS * 1000);
  const elapsed = lastSeen ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
  const durationSeconds = Math.min(COMPETITION_CALL_MAX_SECONDS, s.billableSeconds > 0 ? s.billableSeconds : Math.min(input.durationSeconds, elapsed));
  const ev = input.evaluation;
  const score = input.graded && s.scenarioId === row.scenarioId && typeof ev?.overallScore === "number" ? ev.overallScore : null;
  const valid = validateCompetitionSubmission({ durationSeconds, transcript: input.transcript, method: typeof ev?.method === "string" ? ev.method : null, overallScore: score });
  const goal = ev?.goalAchievement as { achieved?: unknown } | undefined;
  const data = valid.qualified ? { status: "completed", overallScore: Math.round(score!), grade: typeof ev?.grade === "string" ? ev.grade : null, goalAchieved: goal?.achieved === true, durationSeconds, completedAt: now }
    : { status: "abandoned", durationSeconds, completedAt: now };
  const updated = await prisma.competitionEntry.updateMany({ where: { id: row.id, status: "minted" }, data });
  if (!updated.count) return getCompetitionEntryForSession(input.trainerSessionId, input.userId);
  return { ...await resultFor({ ...row, ...data }), ...(!valid.qualified ? { reason: valid.reason, message: valid.message } : {}) };
}

export async function updateCompetitionProfile(userId: string, input: { displayName: string; teamLabel?: string | null }) {
  const displayName = sanitizeDisplayName(input.displayName);
  const teamLabel = sanitizeTeamLabel(input.teamLabel);
  if (!displayName || displayName.includes("@") || teamLabel?.includes("@")) return null;
  const cfg = competitionConfig();
  if (!cfg.demoMode) await prisma.competitionEntry.updateMany({ where: { seasonSlug: cfg.slug, userId }, data: { displayName, teamLabel } });
  return { displayName, teamLabel };
}
export async function getCompetitionEntryForSession(trainerSessionId: string, userId: string): Promise<CompetitionFinalizeResult | null> {
  if (competitionConfig().demoMode) return null;
  const row = await prisma.competitionEntry?.findFirst({ where: { trainerSessionId, userId, status: { in: ["completed", "abandoned"] } } });
  return row ? resultFor(row) : null;
}

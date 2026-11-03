/**
 * Team view aggregation and training-assignment rules.
 *
 * Pure functions only (no Prisma, no browser APIs) so the overview route, the
 * demo sample payload, the browser-only demo store and the tests all share one
 * implementation of averages, weakest criterion, the coaching queue, the
 * rep-by-criterion matrix and assignment completion.
 */
import { z } from "zod";
import { isLegacyGrader } from "./grader-types";

const DAY = 86_400_000;

export const TEAM_WINDOWS = [7, 30, 90] as const;
export type TeamWindow = (typeof TEAM_WINDOWS)[number];
export const DEFAULT_WINDOW: TeamWindow = 30;
/** Sessions under this score land in the coaching queue. */
export const LOW_SCORE = 60;
/** The same weakest criterion this many times in the window flags the rep... */
export const REPEAT_WEAKNESS = 3;
/** ...counting only calls where it scored under this, so a strong rep's least-strong area is not flagged. */
export const REPEAT_WEAKNESS_BELOW = 70;
export const MATRIX_COLUMNS = 6;
export const SPARK_POINTS = 8;
export const QUEUE_LIMIT = 25;
export const NOTE_MAX = 500;

export type TeamRole = "trainee" | "manager" | "owner";
export const ROLE_LABEL: Record<TeamRole, string> = { trainee: "Rep", manager: "Manager", owner: "Owner" };

/** Managers and owners of an org, plus platform admins, can open the team view. */
export function canManageTeam(role: string | null | undefined, isPlatformAdmin = false): boolean {
  return isPlatformAdmin || role === "manager" || role === "owner";
}

export function parseWindow(raw: string | number | null | undefined): TeamWindow {
  const n = Number(raw);
  return (TEAM_WINDOWS as readonly number[]).includes(n) ? (n as TeamWindow) : DEFAULT_WINDOW;
}

/** Display name from a user row; falls back to the email's local part so emails are never shown in full. */
export function memberName(u: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const full = [u.firstName, u.lastName].map((s) => s?.trim()).filter(Boolean).join(" ");
  return full || u.email?.split("@")[0] || "Unnamed member";
}

// ─── Sessions and criteria ────────────────────────────────────────────────

export interface CriterionScore { name: string; score: number }

export interface TeamMember { id: string; name: string; role: TeamRole }

/** One practice session, reduced to what the team view needs. */
export interface TeamSession {
  id: string;
  userId: string;
  scenarioId: string;
  scenarioTitle: string;
  /** Null when ungraded or graded by the legacy keyword grader (different scale). */
  score: number | null;
  goalAchieved: boolean | null;
  /** Empty when the evaluation was not loaded (outside the window) or failed. */
  criteria: CriterionScore[];
  createdAt: string;
  hasNotes: boolean;
}

/** Reads criterion scores out of a stored evaluation blob, skipping anything malformed. */
export function criteriaOf(evaluation: unknown): CriterionScore[] {
  const list = (evaluation as { criteria?: unknown } | null)?.criteria;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    const name = typeof c?.name === "string" ? c.name.trim().slice(0, 120) : "";
    const score = typeof c?.score === "number" && Number.isFinite(c.score) ? Math.max(0, Math.min(100, c.score)) : null;
    return name && score !== null ? [{ name, score }] : [];
  });
}

/** Keyword-grader evaluations from before versioning: a different scale, left out of all team math. */
export const isLegacyEvaluation = (evaluation: unknown): boolean =>
  !!evaluation && typeof evaluation === "object" && isLegacyGrader(evaluation as { graderVersion?: string; method: "llm" | "heuristic" });

/** Score used in team math. Legacy keyword-grader sessions are left out, as on the rep dashboard. */
export function scoreOf(overallScore: number | null | undefined, evaluation: unknown): number | null {
  if (typeof overallScore !== "number" || !Number.isFinite(overallScore)) return null;
  if (isLegacyEvaluation(evaluation)) return null;
  return Math.round(overallScore);
}

/**
 * Score and criterion scores together, so one rule decides both: a session that doesn't count
 * for the score (ungraded or legacy grader) doesn't feed the matrix, weakest criterion or queue either.
 */
export function gradeOf(overallScore: number | null | undefined, evaluation: unknown): { score: number | null; criteria: CriterionScore[] } {
  const score = scoreOf(overallScore, evaluation);
  return { score, criteria: score === null ? [] : criteriaOf(evaluation) };
}

/** Rounded mean of the numeric values, or null when there are none. */
export function average(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length ? Math.round(nums.reduce((a, v) => a + v, 0) / nums.length) : null;
}

/** Lowest-scoring criterion of one session; the first listed wins a tie. */
export function weakestCriterion(criteria: CriterionScore[]): CriterionScore | null {
  return criteria.reduce<CriterionScore | null>((low, c) => (!low || c.score < low.score ? c : low), null);
}

/** Lowest average criterion across sessions (ties broken by name so results are stable). */
export function weakestAcross(sessions: TeamSession[]): { name: string; avg: number; n: number } | null {
  const agg = new Map<string, number[]>();
  for (const s of sessions) for (const c of s.criteria) agg.set(c.name, [...(agg.get(c.name) ?? []), c.score]);
  let best: { name: string; avg: number; n: number } | null = null;
  for (const [name, scores] of agg) {
    const avg = average(scores)!;
    if (!best || avg < best.avg || (avg === best.avg && name < best.name)) best = { name, avg, n: scores.length };
  }
  return best;
}

const byDate = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);

/** Last `points` graded scores, oldest first, for a sparkline. */
export function sparkline(sessions: TeamSession[], points = SPARK_POINTS): number[] {
  return [...sessions].sort(byDate).flatMap((s) => (s.score === null ? [] : [s.score])).slice(-points);
}

/** The most common criterion names, most frequent first, then alphabetical. */
export function topCriteria(sessions: TeamSession[], n = MATRIX_COLUMNS): string[] {
  const freq = new Map<string, number>();
  for (const s of sessions) for (const c of new Set(s.criteria.map((x) => x.name))) freq.set(c, (freq.get(c) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name]) => name);
}

export type ScoreBand = "ok" | "signal" | "caution" | "none";
/** Same ramp as the rep view: 80+ on track, 60 to 79 developing, under 60 needs work. */
export function scoreBand(score: number | null | undefined): ScoreBand {
  if (typeof score !== "number") return "none";
  return score >= 80 ? "ok" : score >= 60 ? "signal" : "caution";
}
export const BAND_LABEL: Record<ScoreBand, string> = { ok: "On track", signal: "Developing", caution: "Needs work", none: "No data" };

// ─── Matrix and coaching queue ────────────────────────────────────────────

export interface TeamMatrix {
  criteria: string[];
  rows: { repId: string; name: string; cells: (number | null)[]; counts: number[] }[];
}

export function buildMatrix(reps: { id: string; name: string }[], sessions: TeamSession[], criteria: string[]): TeamMatrix {
  return {
    criteria,
    rows: reps.map((r) => {
      const mine = sessions.filter((s) => s.userId === r.id);
      const per = criteria.map((c) => mine.flatMap((s) => s.criteria.filter((x) => x.name === c).map((x) => x.score)));
      return { repId: r.id, name: r.name, cells: per.map((v) => average(v)), counts: per.map((v) => v.length) };
    }),
  };
}

export type QueueReasonKind = "low_score" | "goal_missed" | "repeat_weakness";
export interface QueueReason { kind: QueueReasonKind; label: string }

export interface QueueItem {
  sessionId: string;
  repId: string;
  repName: string;
  scenarioId: string;
  scenarioTitle: string;
  score: number | null;
  createdAt: string;
  hasNotes: boolean;
  reasons: QueueReason[];
  /** Plain-language summary of the reasons. */
  reason: string;
}

/** Reasons from a single session (low score, missed goal). Repeated weaknesses are added by buildQueue. */
export function sessionReasons(s: Pick<TeamSession, "score" | "goalAchieved">): QueueReason[] {
  const out: QueueReason[] = [];
  if (s.score !== null && s.score < LOW_SCORE) out.push({ kind: "low_score", label: `Scored ${s.score}, under ${LOW_SCORE}` });
  if (s.goalAchieved === false) out.push({ kind: "goal_missed", label: "Missed the call goal" });
  return out;
}

/**
 * Sessions a manager should look at. A repeated weakest criterion is attached
 * once, to the rep's latest session with that weakness, so one habit does not
 * flood the queue. Unnoted items come first, then the ones with more reasons,
 * then the newest.
 */
export function buildQueue(sessions: TeamSession[], members: TeamMember[], limit = QUEUE_LIMIT): QueueItem[] {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const extra = new Map<string, QueueReason[]>();
  const byRep = new Map<string, TeamSession[]>();
  for (const s of sessions) byRep.set(s.userId, [...(byRep.get(s.userId) ?? []), s]);
  for (const list of byRep.values()) {
    const tally = new Map<string, TeamSession[]>();
    for (const s of list) {
      const w = weakestCriterion(s.criteria);
      if (w && w.score < REPEAT_WEAKNESS_BELOW) tally.set(w.name, [...(tally.get(w.name) ?? []), s]);
    }
    for (const [name, hits] of tally) {
      if (hits.length < REPEAT_WEAKNESS) continue;
      const latest = [...hits].sort(byDate).at(-1)!;
      extra.set(latest.id, [...(extra.get(latest.id) ?? []), { kind: "repeat_weakness", label: `Weakest on ${name} ${hits.length} times` }]);
    }
  }
  return sessions
    .flatMap((s): QueueItem[] => {
      const reasons = [...sessionReasons(s), ...(extra.get(s.id) ?? [])];
      if (!reasons.length) return [];
      return [{
        sessionId: s.id, repId: s.userId, repName: names.get(s.userId) ?? "Former member", scenarioId: s.scenarioId, scenarioTitle: s.scenarioTitle,
        score: s.score, createdAt: s.createdAt, hasNotes: s.hasNotes, reasons, reason: reasons.map((r) => r.label).join(" · "),
      }];
    })
    .sort((a, b) => Number(a.hasNotes) - Number(b.hasNotes) || b.reasons.length - a.reasons.length || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

// ─── Assignments ──────────────────────────────────────────────────────────

/** Input shared by the API route and the demo store. */
export const AssignmentInputSchema = z.object({
  /** Omitted or null means the whole team. */
  assigneeId: z.string().trim().min(1).max(64).nullish(),
  scenarioId: z.string().trim().min(1).max(80),
  scenarioTitle: z.string().trim().min(1).max(120),
  note: z.string().trim().max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters.`).nullish(),
  /** ISO date ("2026-11-03") or ISO date-time. */
  dueAt: z.string().trim().max(40).nullish(),
});
export type AssignmentInput = z.infer<typeof AssignmentInputSchema>;

/** Plain-language message for the first invalid field of an assignment. */
export function assignmentInputMessage(field: unknown): string {
  switch (field) {
    case "note": return `Keep the note under ${NOTE_MAX} characters.`;
    case "assigneeId": return "Pick a rep or the whole team.";
    case "dueAt": return "Use a date like 2026-11-03 for the due date.";
    default: return "Pick a persona to assign.";
  }
}

export interface Assignment {
  id: string;
  assignedById: string;
  assigneeId: string | null;
  scenarioId: string;
  scenarioTitle: string;
  note: string | null;
  dueAt: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** Set on a manager's whole-team assignment: it reaches only that manager's reps. */
  teamOfId?: string | null;
}

export interface AssignmentProgress {
  /** People who have practised it since it was assigned. */
  done: number;
  /** 1 for a single rep (or the viewer); the team size for whole-team assignments. */
  total: number;
  lastDoneAt: string | null;
  /** The completing session, when exactly one person is tracked. */
  sessionId: string | null;
  /**
   * Set when the org's session retention may have deleted the session that completed this
   * assignment, so "not done" can't be trusted. Such assignments are never shown as overdue.
   */
  historyPurged?: boolean;
}

export interface AssignmentView extends Assignment {
  assigneeName: string | null;
  assignedByName: string | null;
  progress: AssignmentProgress;
}

export interface CompletionSession { id: string; userId: string; scenarioId: string; createdAt: string }

/** Due dates may be a calendar date (taken as the end of that day, UTC) or a full ISO date-time, from yesterday up to a year out. */
export function parseDueAt(raw: string | null | undefined, now: Date): { ok: true; value: Date | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw.trim() === "") return { ok: true, value: null };
  const s = raw.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return { ok: false, message: "Use a date like 2026-11-03 for the due date." };
  }
  const d = new Date(dateOnly ? `${s}T23:59:59.999Z` : s);
  if (Number.isNaN(d.getTime())) return { ok: false, message: "That due date is not a real date. Pick one from the calendar." };
  if (d.getTime() < now.getTime() - DAY || d.getTime() > now.getTime() + 366 * DAY) {
    return { ok: false, message: "Pick a due date between today and a year from now." };
  }
  return { ok: true, value: d };
}

/** The first session by this user on the assigned persona after it was assigned. */
export function completedBy(a: Pick<Assignment, "scenarioId" | "createdAt">, userId: string, sessions: CompletionSession[]): CompletionSession | null {
  return sessions
    .filter((s) => s.userId === userId && s.scenarioId === a.scenarioId && Date.parse(s.createdAt) > Date.parse(a.createdAt))
    .sort(byDate)[0] ?? null;
}

/** Team perspective: one rep, or every rep on the team for a whole-team assignment. */
export function assignmentProgress(a: Assignment, sessions: CompletionSession[], teamIds: string[]): AssignmentProgress {
  const people = a.assigneeId ? [a.assigneeId] : teamIds;
  const hits = people.map((id) => completedBy(a, id, sessions)).filter((x): x is CompletionSession => !!x);
  return {
    done: hits.length,
    total: people.length,
    lastDoneAt: hits.map((h) => h.createdAt).sort().at(-1) ?? null,
    sessionId: people.length === 1 ? hits[0]?.id ?? null : null,
  };
}

/** Viewer perspective (the "Assigned to you" panel): has this one person done it? */
export function progressFor(a: Assignment, userId: string, sessions: CompletionSession[]): AssignmentProgress {
  const hit = completedBy(a, userId, sessions);
  return { done: hit ? 1 : 0, total: 1, lastDoneAt: hit?.createdAt ?? null, sessionId: hit?.id ?? null };
}

export const isComplete = (p: AssignmentProgress) => p.total > 0 && p.done >= p.total;

export function isOverdue(a: Pick<AssignmentView, "dueAt" | "progress">, now: Date): boolean {
  return !!a.dueAt && Date.parse(a.dueAt) < now.getTime() && !isComplete(a.progress) && !a.progress.historyPurged;
}

/**
 * Completion is derived from sessions. With a retention window of N days, a session older than
 * N days is gone, so an incomplete assignment created before that cutoff might really be done.
 */
export function withRetention(progress: AssignmentProgress, assignedAt: string, retentionDays: number | null | undefined, now: Date): AssignmentProgress {
  if (!retentionDays || retentionDays <= 0 || isComplete(progress)) return progress;
  return Date.parse(assignedAt) < now.getTime() - retentionDays * DAY ? { ...progress, historyPurged: true } : progress;
}

/** Whole team = the org's reps (trainees). Managers can practise, but assignments are for the team. */
export const teamIdsOf = (members: TeamMember[]) => members.filter((m) => m.role === "trainee").map((m) => m.id);

export function toAssignmentView(a: Assignment, names: Map<string, string>, progress: AssignmentProgress): AssignmentView {
  return { ...a, assigneeName: a.assigneeId ? names.get(a.assigneeId) ?? "Former member" : null, assignedByName: names.get(a.assignedById) ?? null, progress };
}

export interface AssignmentSummary { active: number; teamWide: number; completed: number; overdue: number }

export function summarizeAssignments(views: AssignmentView[], now: Date): AssignmentSummary {
  const live = views.filter((v) => !v.archivedAt);
  return {
    active: live.length,
    teamWide: live.filter((v) => !v.assigneeId).length,
    completed: live.filter((v) => isComplete(v.progress)).length,
    overdue: live.filter((v) => isOverdue(v, now)).length,
  };
}

/** Viewer's list order: open work first, soonest due first, then newest. */
export function sortForAssignee(views: AssignmentView[]): AssignmentView[] {
  const due = (v: AssignmentView) => (v.dueAt ? Date.parse(v.dueAt) : Number.MAX_SAFE_INTEGER);
  return [...views].sort((a, b) => Number(isComplete(a.progress)) - Number(isComplete(b.progress)) || due(a) - due(b) || b.createdAt.localeCompare(a.createdAt));
}

// ─── Overview ─────────────────────────────────────────────────────────────

export interface RosterRow {
  id: string;
  name: string;
  role: TeamRole;
  /** Sessions in the window. */
  sessions: number;
  avgScore: number | null;
  lastSessionAt: string | null;
  lastScore: number | null;
  weakest: string | null;
  weakestScore: number | null;
  /** Last SPARK_POINTS graded scores, oldest first. */
  spark: number[];
}

export interface TeamKpis {
  activeReps: number;
  totalReps: number;
  sessions: number;
  avgScore: number | null;
  coverage: { practised: number; library: number; pct: number };
}

export interface TeamOverview {
  /** True for the made-up demo team (demo mode or no database). */
  sample: boolean;
  org: { id: string; name: string };
  days: TeamWindow;
  generatedAt: string;
  kpis: TeamKpis;
  roster: RosterRow[];
  matrix: TeamMatrix;
  queue: QueueItem[];
  /** Everyone in the org, for the assignee picker. */
  members: TeamMember[];
  assignments: AssignmentSummary;
}

export interface OverviewInput {
  org: { id: string; name: string };
  days: TeamWindow;
  now: Date;
  members: TeamMember[];
  /** Sessions covering at least the window (older ones feed sparklines and last-session columns). */
  sessions: TeamSession[];
  /** Latest session per user from all time, for reps with nothing in `sessions`. */
  lastSeen?: Record<string, string>;
  libraryIds: string[];
  assignments?: AssignmentView[];
  sample?: boolean;
}

export function buildOverview(input: OverviewInput): TeamOverview {
  const { members, sessions, now, days } = input;
  const since = now.getTime() - days * DAY;
  const inWindow = (s: TeamSession) => Date.parse(s.createdAt) >= since;
  const windowed = sessions.filter(inWindow);
  const byUser = new Map<string, TeamSession[]>();
  for (const s of sessions) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);

  // Reps always appear; managers and owners only once they have practised.
  const roster: RosterRow[] = members
    .filter((m) => m.role === "trainee" || byUser.has(m.id))
    .map((m) => {
      const all = [...(byUser.get(m.id) ?? [])].sort(byDate);
      const recent = all.filter(inWindow);
      const last = all.at(-1);
      const weak = weakestAcross(recent);
      return {
        id: m.id, name: m.name, role: m.role, sessions: recent.length, avgScore: average(recent.map((s) => s.score)),
        lastSessionAt: last?.createdAt ?? input.lastSeen?.[m.id] ?? null, lastScore: last?.score ?? null,
        weakest: weak?.name ?? null, weakestScore: weak?.avg ?? null, spark: sparkline(all),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const rosterIds = new Set(roster.map((r) => r.id));
  const library = new Set(input.libraryIds);
  const practised = new Set(windowed.map((s) => s.scenarioId).filter((id) => library.has(id)));
  const kpis: TeamKpis = {
    activeReps: new Set(windowed.map((s) => s.userId).filter((id) => rosterIds.has(id))).size,
    totalReps: roster.length,
    sessions: windowed.length,
    avgScore: average(windowed.map((s) => s.score)),
    coverage: { practised: practised.size, library: library.size, pct: library.size ? Math.round((practised.size / library.size) * 100) : 0 },
  };

  return {
    sample: !!input.sample,
    org: input.org,
    days,
    generatedAt: now.toISOString(),
    kpis,
    roster,
    matrix: buildMatrix(roster, windowed, topCriteria(windowed)),
    queue: buildQueue(windowed, members),
    members: [...members].sort((a, b) => a.name.localeCompare(b.name)),
    assignments: summarizeAssignments(input.assignments ?? [], now),
  };
}

// ─── Display helpers ──────────────────────────────────────────────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = (from: Date, to: Date) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);

/** "today", "yesterday", "4 days ago", or a short date beyond two weeks. */
export function relativeDay(iso: string, now: Date): string {
  const d = new Date(iso);
  const n = dayDiff(d, now);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 14) return `${n} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** "Due today", "Due in 3 days", "Overdue by 2 days", or "Due Nov 3". */
export function dueLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const n = dayDiff(now, d);
  if (n < -1) return `Overdue by ${-n} days`;
  if (n === -1) return "Overdue by 1 day";
  if (n === 0) return d.getTime() < now.getTime() ? "Overdue today" : "Due today";
  if (n === 1) return "Due tomorrow";
  if (n < 7) return `Due in ${n} days`;
  return `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/** One CSV field. Values that a spreadsheet would run as a formula get a leading quote. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rosterCsv(rows: RosterRow[], days: TeamWindow): string {
  const head = ["Name", "Role", `Sessions (${days} days)`, "Average score", "Last session", "Last score", "Weakest criterion", "Weakest average", "Recent scores"];
  const body = rows.map((r) => [
    r.name, ROLE_LABEL[r.role], r.sessions, r.avgScore, r.lastSessionAt?.slice(0, 10) ?? null, r.lastScore, r.weakest, r.weakestScore, r.spark.join(" "),
  ].map(csvCell).join(","));
  return [head.map(csvCell).join(","), ...body].join("\r\n") + "\r\n";
}

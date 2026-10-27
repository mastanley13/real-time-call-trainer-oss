/**
 * A made-up team for demo mode and installs without a database.
 *
 * Built from real library personas and passed through the same aggregation as
 * live data (src/lib/team.ts), so the sample exercises the real code path. The
 * generator is seeded per rep, so every request and every time window shows the
 * same team. The payload always carries `sample: true` and the UI labels it.
 */
import { LIBRARY } from "./personas";
import { JOB_FAMILIES, type Scenario } from "./scenarios";
import { buildOverview, type CriterionScore, type TeamMember, type TeamOverview, type TeamRole, type TeamSession, type TeamWindow } from "./team";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const SAMPLE_ORG = { id: "sample-org", name: "Harbor Point Sales" };
export const isSampleId = (id: string) => id.startsWith("sample-");

/** Generic rubric names, so the sample heatmap reads like a real team's. The last two are not on every rubric. */
export const SAMPLE_CRITERIA = ["Discovery questions", "Active listening", "Value framing", "Objection handling", "Specific next step", "Opening and agenda", "Rapport and tone"];
const OPTIONAL_FROM = 5;

/** One persona from each of the first ten job families. */
const SCENARIOS: Scenario[] = JOB_FAMILIES.map((f) => LIBRARY.find((s) => s.role === f.id)).filter((s): s is Scenario => !!s).slice(0, 10);

interface Profile {
  slug: string;
  name: string;
  role: TeamRole;
  /** Typical score, and how many points it rose over the 90 days. */
  base: number;
  trend: number;
  /** Days between calls, and days since the last one. */
  every: number;
  quietFor: number;
  /** For new hires: only practised in the last N days. */
  joinedDaysAgo?: number;
  /** Per-criterion offsets that make each rep's weak spot consistent. */
  weak: Record<string, number>;
  goalBias?: number;
}

const PROFILES: Profile[] = [
  { slug: "priya", name: "Priya Raman", role: "trainee", base: 86, trend: 4, every: 3, quietFor: 0, weak: { "Value framing": -9 } },
  { slug: "marcus", name: "Marcus Bell", role: "trainee", base: 56, trend: 6, every: 2.5, quietFor: 1, weak: { "Objection handling": -24, "Specific next step": -6 }, goalBias: -0.2 },
  { slug: "sofia", name: "Sofia Alvarez", role: "trainee", base: 71, trend: 14, every: 3.5, quietFor: 2, weak: { "Discovery questions": -11 } },
  { slug: "daniel", name: "Daniel Okafor", role: "trainee", base: 67, trend: 0, every: 4, quietFor: 3, weak: { "Specific next step": -17 }, goalBias: -0.35 },
  { slug: "hannah", name: "Hannah Kim", role: "trainee", base: 63, trend: 0, every: 1.5, quietFor: 0, joinedDaysAgo: 6, weak: { "Opening and agenda": -12 } },
  { slug: "luis", name: "Luis Moreno", role: "trainee", base: 73, trend: -3, every: 6, quietFor: 41, weak: { "Active listening": -9 } },
  { slug: "amara", name: "Amara Nwosu", role: "trainee", base: 82, trend: 5, every: 5, quietFor: 6, weak: { "Rapport and tone": -7 } },
  { slug: "tom", name: "Tom Fischer", role: "trainee", base: 62, trend: -5, every: 3, quietFor: 1, weak: { "Discovery questions": -14, "Objection handling": -9 } },
  { slug: "jordan", name: "Jordan Lee", role: "manager", base: 80, trend: 0, every: 18, quietFor: 4, weak: { "Active listening": -6 } },
];

/** mulberry32: a tiny seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function sessionsFor(p: Profile, anchor: number): TeamSession[] {
  const r = rng(seedOf(p.slug));
  const start = anchor - (p.joinedDaysAgo ?? 95) * DAY;
  const out: TeamSession[] = [];
  // Calls land between 9:00 and 17:00 so the dates look like a working week.
  let t = anchor - p.quietFor * DAY - (1 + r() * 6) * HOUR;
  for (let i = 0; t > start && i < 60; i++) {
    const age = (anchor - t) / (90 * DAY);
    // Base, trend over the quarter, plus the rep's form on the day.
    const level = p.base + p.trend * (0.5 - age) + (r() - 0.5) * 14;
    const keepOptional = r() < 0.5 ? OPTIONAL_FROM : OPTIONAL_FROM + 1;
    const criteria: CriterionScore[] = SAMPLE_CRITERIA.filter((_, k) => k < OPTIONAL_FROM || k === keepOptional).map((name) => ({
      name, score: Math.round(clamp(level + (p.weak[name] ?? 0) + (r() - 0.5) * 12, 12, 99)),
    }));
    const score = Math.round(clamp(criteria.reduce((a, c) => a + c.score, 0) / criteria.length + (r() - 0.5) * 4, 10, 99));
    const scenario = SCENARIOS[Math.floor(r() * SCENARIOS.length)];
    const goalAchieved = r() < clamp((score - 48) / 36 + (p.goalBias ?? 0), 0.05, 0.95);
    out.push({
      id: `sample-${p.slug}-${i}`, userId: `sample-rep-${p.slug}`, scenarioId: scenario.id, scenarioTitle: scenario.title,
      score, goalAchieved, criteria, createdAt: new Date(t).toISOString(), hasNotes: r() < 0.18,
    });
    t -= p.every * DAY * (0.6 + r() * 0.8);
  }
  return out;
}

/** The sample team's members and 90-plus days of sessions, anchored to the start of the current hour. */
export function buildSampleTeam(now: Date, viewer?: { id: string; name: string }) {
  const anchor = Math.floor(now.getTime() / HOUR) * HOUR;
  const members: TeamMember[] = PROFILES.map((p) => ({ id: `sample-rep-${p.slug}`, name: p.name, role: p.role }));
  // The viewer joins as the owner so "assign to me" works end to end in demo mode.
  if (viewer) members.push({ id: viewer.id, name: viewer.name, role: "owner" });
  return { anchor: new Date(anchor), members, sessions: PROFILES.flatMap((p) => sessionsFor(p, anchor)) };
}

export function buildSampleOverview(days: TeamWindow, now: Date, viewer?: { id: string; name: string }): TeamOverview {
  const team = buildSampleTeam(now, viewer);
  return buildOverview({
    org: SAMPLE_ORG, days, now: team.anchor, members: team.members, sessions: team.sessions,
    libraryIds: LIBRARY.map((s) => s.id), sample: true,
  });
}

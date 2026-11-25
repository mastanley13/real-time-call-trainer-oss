import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitionEntry } from "@prisma/client";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ db: {} as Record<string, unknown> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, key) => mocks.db[String(key)] }) }));

import {
  COMPETITION_TRACKS, competitionPhase, validateCompetitionSubmission, compareLeaderboardRows,
  defaultDisplayName, sanitizeDisplayName,
} from "@/lib/competition";
import { LIBRARY } from "@/lib/personas";
import {
  claimCompetitionAttempt, attachSessionToCompetitionEntry, refundCompetitionEntry,
  getCompetitionStatus, getCompetitionShareCard, finalizeCompetitionEntry, competitionConfig,
} from "@/lib/competitionServer";
import { beginCall, heartbeat, endCall } from "@/lib/usage";
import { NextRequest } from "next/server";
import { GET as getCard } from "@/app/api/competition/card/[token]/route";

const now = new Date("2026-11-25T00:00:00Z");
const at = (sec: number) => new Date(now.getTime() + sec * 1000);
const transcript = Array.from({ length: 4 }, (_, i) => ({ role: "user", text: `Rep turn ${i}` }));
const evaluation = { method: "llm", overallScore: 90, grade: "A", goalAchievement: { achieved: true } };
let entries: CompetitionEntry[];
let fake: ReturnType<typeof createFakePrisma>;
function seed(overrides: Partial<CompetitionEntry> = {}): CompetitionEntry {
  const row: CompetitionEntry = {
    id: `entry-${entries.length + 1}`, userId: "u1", seasonSlug: "launch-2026", trainerSessionId: null,
    trackSlug: "dealerships", scenarioId: "auto-pickup-negotiation-rival-quote", attemptNumber: 1,
    status: "minted", displayName: "Fictional Rep", teamLabel: null, overallScore: null, grade: null,
    goalAchieved: null, durationSeconds: 0, shareToken: `card-${entries.length + 1}`, createdAt: now,
    completedAt: null, updatedAt: now, ...overrides,
  };
  entries.push(row);
  return row;
}

function matches(row: CompetitionEntry, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    const actual = row[key as keyof CompetitionEntry];
    if (value && typeof value === "object") {
      const filter = value as { in?: unknown[]; not?: unknown; lt?: Date };
      if (filter.in) return filter.in.includes(actual);
      if ("not" in filter) return actual !== filter.not;
      if (filter.lt) return actual instanceof Date && actual < filter.lt;
    }
    return actual === value;
  });
}
beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("COMPETITION_ENABLED", "true");
  vi.stubEnv("COMPETITION_SLUG", "launch-2026");
  vi.stubEnv("COMPETITION_START_AT", "");
  vi.stubEnv("COMPETITION_END_AT", "");
  vi.stubEnv("COMPETITION_MAX_TOTAL_CALLS", "");
  entries = [];
  fake = createFakePrisma();
  fake.seed("user", { id: "u1", email: "private@example.test", organizationId: "org1" });
  const withSession = (r: CompetitionEntry) => ({ ...r, trainerSession: fake.rows("trainerSession").find((s) => s.id === r.trainerSessionId) ?? null });
  const table = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => entries.filter((r) => matches(r, where)).map(withSession)),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => { const r = entries.find((r) => matches(r, where)); return r ? withSession(r) : null; }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => entries.find((r) => matches(r, where)) ?? null),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => entries.filter((r) => matches(r, where)).length),
    create: vi.fn(async ({ data }: { data: Partial<CompetitionEntry> }) => seed(data)),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<CompetitionEntry> }) => {
      const found = entries.filter((r) => matches(r, where));
      found.forEach((r) => Object.assign(r, data));
      return { count: found.length };
    }),
  };
  mocks.db = { ...fake.db, competitionEntry: table, $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fake.db.$transaction(async (tx) => fn({ ...(tx as object), competitionEntry: table })) };
});
afterEach(() => vi.unstubAllEnvs());

const claim = (sec = 0) => claimCompetitionAttempt({ userId: "u1", trackSlug: "dealerships", now: at(sec) });
async function mint(sec = 0) {
  const result = await claim(sec);
  if (!result.ok) throw new Error(result.error);
  const started = await beginCall("u1", { id: result.entry.scenarioId }, at(sec), { competition: true });
  if (!started.ok) throw new Error(started.error);
  await attachSessionToCompetitionEntry(result.entry.id, started.callId);
  return { entry: result.entry, ...started };
}

describe("shared competition contract", () => {
  it("maps all seven tracks to canonical personas", () => {
    expect(COMPETITION_TRACKS).toHaveLength(7);
    for (const track of COMPETITION_TRACKS) expect(LIBRARY.some((s) => s.id === track.scenarioId)).toBe(true);
    expect(COMPETITION_TRACKS.find((t) => t.slug === "dealerships")?.scenarioId).toBe("auto-pickup-negotiation-rival-quote");
  });
  it("uses the configured phase and handles the end boundary", () => {
    const window = { enabled: true, startAt: now, endAt: at(30) };
    expect(competitionPhase({ ...window, enabled: false }, now)).toBe("disabled");
    expect(competitionPhase(window, at(-1))).toBe("upcoming");
    expect(competitionPhase(window, now)).toBe("active");
    expect(competitionPhase(window, at(30))).toBe("ended");
  });
  it("enforces AI grading, duration, and trainee turns", () => {
    const base = { durationSeconds: 60, transcript, method: "llm", overallScore: 90 };
    expect(validateCompetitionSubmission({ ...base, method: "heuristic" })).toMatchObject({ reason: "not_ai_graded" });
    expect(validateCompetitionSubmission({ ...base, overallScore: null })).toMatchObject({ reason: "missing_score" });
    expect(validateCompetitionSubmission({ ...base, durationSeconds: 44 })).toMatchObject({ reason: "too_short" });
    expect(validateCompetitionSubmission({ ...base, transcript: transcript.slice(1) })).toMatchObject({ reason: "too_few_turns" });
    expect(validateCompetitionSubmission(base)).toEqual({ qualified: true });
  });
  it("sorts by score, goal, then first to post", () => {
    const a = { overallScore: 90, goalAchieved: true, completedAt: now };
    expect(compareLeaderboardRows(a, { ...a, overallScore: 91 })).toBeGreaterThan(0);
    expect(compareLeaderboardRows(a, { ...a, goalAchieved: false })).toBeLessThan(0);
    expect(compareLeaderboardRows(a, { ...a, completedAt: at(1) })).toBeLessThan(0);
  });
  it("does not expose the email address and sanitizes public names", () => {
    expect(defaultDisplayName({ email: "rep@example.test" })).toBe("rep");
    expect(defaultDisplayName({ firstName: "Fictional", lastName: "Person", email: "rep@example.test" })).toBe("Fictional P.");
    expect(sanitizeDisplayName("  Alex\u0000   Example  ")).toBe("Alex Example");
  });
});

describe("official attempts and metering", () => {
  it("limits each account to three consumed attempts", async () => {
    for (let i = 1; i <= 3; i++) seed({ attemptNumber: i, status: "abandoned" });
    expect(await claim()).toEqual({ ok: false, error: "attempts_exhausted" });
  });
  it("prevents a second active claim and reuses a refunded slot", async () => {
    const first = await claim();
    expect(first.ok).toBe(true);
    expect(await claim()).toEqual({ ok: false, error: "call_in_progress" });
    if (!first.ok) throw new Error("claim failed");
    await refundCompetitionEntry(first.entry.id);
    expect(entries[0]).toMatchObject({ status: "refunded", attemptNumber: null });
    expect(await claim()).toMatchObject({ ok: true, entry: { attemptNumber: 1 } });
  });
  it("returns zero billed minutes and refunds a call that never connects", async () => {
    const started = await mint();
    expect(started).toMatchObject({ remaining: 6, engine: "standard", maxSeconds: 360 });
    expect(fake.rows("trainerSession")[0]).toMatchObject({ isCompetition: true, allowanceId: null, reservedMinutes: 6 });
    expect(await endCall("u1", started.callId, "failed_connect", at(10))).toMatchObject({ billableSeconds: 0, billedMinutes: 0 });
    expect(entries[0]).toMatchObject({ status: "refunded", attemptNumber: null });
    expect(fake.rows("usageAllowance")).toHaveLength(0);
    expect(fake.rows("usageEntry")).toHaveLength(0);
  });
  it("reclaims a stale pre-connect session and reuses its attempt", async () => {
    await mint();
    expect(await claim(46)).toMatchObject({ ok: true, entry: { attemptNumber: 1 } });
    expect(entries[0]).toMatchObject({ status: "refunded", attemptNumber: null });
    expect(fake.rows("trainerSession")[0]).toMatchObject({ endReason: "failed_connect" });
  });
  it("consumes a connected hangup, stops at 360 seconds, and never uses paid minutes", async () => {
    const started = await mint();
    await heartbeat("u1", started.callId, "connected", at(1));
    expect(await heartbeat("u1", started.callId, "ok", at(361))).toMatchObject({ stop: true, reason: "max_duration", settlement: { billedMinutes: 0, billableSeconds: 360 } });
    expect(await endCall("u1", started.callId, "user_hangup", at(362))).toMatchObject({ billedMinutes: 0 });
    expect(await claim(363)).toMatchObject({ ok: true, entry: { attemptNumber: 2 } });
    expect(entries[0]).toMatchObject({ status: "abandoned", attemptNumber: 1 });
    expect(fake.rows("usageEntry")).toHaveLength(0);
  });
  it("serializes two concurrent claims for one account", async () => {
    const results = await Promise.all([claim(), claim()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "call_in_progress" }]);
  });
  it("settles a connected silent call without refunding it", async () => {
    const started = await mint();
    await heartbeat("u1", started.callId, "connected", at(1));
    expect(await claim(33)).toMatchObject({ ok: true, entry: { attemptNumber: 2 } });
    expect(entries[0]).toMatchObject({ status: "abandoned", attemptNumber: 1 });
    expect(fake.rows("trainerSession")[0]).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 0 });
  });
  it("enforces the season-wide circuit breaker across users", async () => {
    vi.stubEnv("COMPETITION_MAX_TOTAL_CALLS", "1");
    seed({ userId: "someone-else", status: "completed" });
    expect(await claim()).toEqual({ ok: false, error: "competition_full" });
  });
  it("uses the server duration instead of trusting a long client duration", async () => {
    const started = await mint();
    await heartbeat("u1", started.callId, "connected", at(1));
    await endCall("u1", started.callId, "user_hangup", at(10));
    expect(await finalizeCompetitionEntry({ userId: "u1", trainerSessionId: started.callId, durationSeconds: 360, transcript, evaluation, graded: true })).toMatchObject({ qualified: false, reason: "too_short" });
    expect(entries[0]).toMatchObject({ status: "abandoned", durationSeconds: 9 });
  });
  it("finalizes a sealed AI grade on a qualifying official call", async () => {
    const started = await mint();
    await heartbeat("u1", started.callId, "connected", at(1));
    await endCall("u1", started.callId, "user_hangup", at(65));
    expect(await finalizeCompetitionEntry({ userId: "u1", trainerSessionId: started.callId, durationSeconds: 64, transcript, evaluation, graded: true })).toMatchObject({ qualified: true, overallScore: 90, overallRank: 1, industryRank: 1 });
  });
});

describe("public rankings and share cards", () => {
  it("deduplicates by user overall and per track and does not expose private fields", async () => {
    const score = { status: "completed", overallScore: 95, grade: "A", completedAt: now, goalAchieved: true };
    const top = seed(score);
    seed({ ...score, overallScore: 93, trackSlug: "solar", attemptNumber: 2 });
    seed({ ...score, userId: "u2", overallScore: 90 });
    const status = await getCompetitionStatus({ userId: "u1" });
    expect(status.leaderboard.map((r) => r.overallScore)).toEqual([95, 90]);
    expect(status.viewer).toMatchObject({ attemptsUsed: 2, attemptsRemaining: 1, bestScore: 95, overallRank: 1 });
    expect((await getCompetitionStatus({ track: "solar" })).leaderboard.map((r) => r.overallScore)).toEqual([93]);
    const card = await getCompetitionShareCard(top.shareToken);
    expect(card).toMatchObject({ overallRank: 1, industryRank: 1, totalEntries: 3 });
    expect(card).not.toHaveProperty("userId");
    expect(card).not.toHaveProperty("email");
    expect(card).not.toHaveProperty("transcript");
    expect(await getCompetitionShareCard("unknown")).toBeNull();
  });
  it("provides a deterministic fictional demo and public card without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DEMO_MODE", "true");
    expect(competitionConfig()).toMatchObject({ enabled: true, demoMode: true, phase: "active" });
    const status = await getCompetitionStatus();
    expect(status.leaderboard).toHaveLength(7);
    expect(status.viewer.authenticated).toBe(false);
    const card = await getCompetitionShareCard("demo-dealerships");
    expect(card).toMatchObject({ trackSlug: "dealerships", demoMode: true });
    const req = new NextRequest("http://localhost/api/competition/card/demo-dealerships");
    expect((await getCard(req, { params: Promise.resolve({ token: "demo-dealerships" }) })).status).toBe(200);
    expect((await getCard(req, { params: Promise.resolve({ token: "!bad" }) })).status).toBe(404);
  });
});

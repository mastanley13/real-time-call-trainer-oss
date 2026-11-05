import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the session check are the only fakes; the GET route and the view builder run for real.
const mocks = vi.hoisted(() => ({
  user: { id: "u-trainee", email: "trainee@example.test" },
  actors: new Map<string, Record<string, unknown>>(),
  prisma: { trainerSession: { findUnique: vi.fn() }, user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET } from "@/app/api/transcripts/[id]/route";
import { SESSION_VIEW_SELECT, sessionView, type SessionViewRow } from "@/lib/sessionView";

const MODEL_ID_RE = /\b(?:[Gg][Pp][Tt]-[\w.-]+|o[34](?:-[\w-]+)?|whisper-1|tts-1(?:-hd)?|gemini-[\w.-]+|eleven_\w+|claude-[\w.-]+)\b/;

const VIEW_KEYS = [
  "createdAt", "durationSeconds", "evaluation", "goalAchieved", "grade", "id", "overallScore", "scenarioCategory", "scenarioDifficulty",
  "scenarioId", "scenarioTitle", "supervisorNotes", "supervisorNotesAt", "supervisorNotesBy", "transcript", "userId",
].sort();

/**
 * A full TrainerSession row as the database would hold it after a Premium voice call: realtimeModel is populated,
 * the metering and billing columns are set, the stored evaluation still carries a legacy grader model id, and two
 * columns that don't exist yet stand in for anything added later.
 */
const fullRow = () => ({
  id: "s-voice-0001",
  userId: "u-trainee",
  organizationId: "o-1",
  realtimeSessionId: "rt-call-0001",
  scenarioId: "home-services-inbound-lead",
  scenarioCategory: "home-services",
  scenarioDifficulty: "medium",
  scenarioTitle: "Leaking water heater",
  durationSeconds: 312,
  connectedAt: new Date("2026-11-01T10:00:00Z"),
  endedAt: new Date("2026-11-01T10:05:12Z"),
  endReason: "user_hangup",
  lastHeartbeatAt: new Date("2026-11-01T10:05:10Z"),
  degradedAt: null,
  billableSeconds: 312,
  billedMinutes: 6,
  allowanceId: "a-1",
  allowancePeriodStart: new Date("2026-10-15T00:00:00Z"),
  reservedMinutes: 10,
  engineTier: "premium",
  voiceTier: "premium",
  realtimeModel: "gpt-realtime-2.1",
  premiumReservedMinutes: 10,
  carriedMinutes: 0,
  carriedPremiumMinutes: 0,
  abuseFlagged: false,
  capEnforced: true,
  transcript: [{ role: "assistant", text: "Hello, this is Sam." }, { role: "user", text: "Hi Sam, thanks for calling." }],
  evaluation: { method: "llm", graderVersion: "llm-v2", model: "gpt-4.1-mini", overallScore: 71 },
  overallScore: 71,
  grade: "C",
  goalAchieved: false,
  supervisorNotes: "Good discovery.",
  supervisorNotesBy: "Ola Reyes",
  supervisorNotesAt: new Date("2026-11-02T09:00:00Z"),
  createdAt: new Date("2026-11-01T10:05:13Z"),
  updatedAt: new Date("2026-11-02T09:00:00Z"),
  futureCostCents: 42,
  futureProviderModel: "gpt-realtime-2.1-mini",
});

/** Signs in as `id`. The mocked findUnique ignores `select`, so the route's own response builder must drop the extras. */
const as = (id: string, actor: Record<string, unknown>) => {
  mocks.user = { id, email: `${id}@example.test` };
  mocks.actors.set(id, { id, isPlatformAdmin: false, ...actor });
};
const get = async (id = "s-voice-0001") => {
  const res = await GET(new NextRequest(`http://localhost/api/transcripts/${id}`), { params: Promise.resolve({ id }) });
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as { session?: Record<string, unknown>; error?: string } };
};

beforeEach(() => {
  mocks.actors = new Map();
  mocks.prisma.trainerSession.findUnique.mockReset().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(where.id === "s-voice-0001" ? fullRow() : null));
  mocks.prisma.user.findUnique.mockReset().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(mocks.actors.get(where.id) ?? null));
});

describe("GET /api/transcripts/[id] with a populated realtimeModel", () => {
  /** Exact keys, nothing from the excluded columns, and no model id anywhere in the body. */
  const expectAllowlisted = (r: Awaited<ReturnType<typeof get>>) => {
    expect(r.res.status).toBe(200);
    const s = r.body.session!;
    expect(Object.keys(s).sort()).toEqual(VIEW_KEYS);
    for (const k of ["realtimeModel", "engineTier", "voiceTier", "organizationId", "realtimeSessionId", "allowanceId", "billedMinutes", "abuseFlagged", "updatedAt", "futureCostCents", "futureProviderModel"]) {
      expect(s).not.toHaveProperty(k);
    }
    expect(r.text).not.toMatch(MODEL_ID_RE);
    expect(r.text).not.toMatch(/gpt-realtime|premium|futureCost/);
    expect(s.evaluation).toEqual({ method: "llm", graderVersion: "llm-v2", overallScore: 71 });
    // What the debrief and retry-from-turn read is still there.
    expect(s).toMatchObject({ id: "s-voice-0001", userId: "u-trainee", scenarioId: "home-services-inbound-lead", scenarioTitle: "Leaking water heater", durationSeconds: 312, supervisorNotes: "Good discovery." });
    expect(s.transcript).toEqual(fullRow().transcript);
  };

  it("the trainee who owns the session gets the allowlisted view, without the model", async () => {
    as("u-trainee", { role: "trainee", organizationId: "o-1" });
    expectAllowlisted(await get());
  });

  it("a manager of the session's organization gets the same allowlisted view", async () => {
    as("u-manager", { role: "manager", organizationId: "o-1" });
    expectAllowlisted(await get());
  });

  it("an owner of the organization and a platform admin get the same view", async () => {
    as("u-owner", { role: "owner", organizationId: "o-1" });
    expectAllowlisted(await get());
    as("u-admin", { role: "trainee", organizationId: "o-other", isPlatformAdmin: true });
    expectAllowlisted(await get());
  });

  it("still refuses another trainee and a manager of another organization", async () => {
    as("u-peer", { role: "trainee", organizationId: "o-1" });
    const peer = await get();
    expect(peer.res.status).toBe(403);
    expect(peer.text).not.toMatch(/gpt-|transcript/);
    as("u-elsewhere", { role: "manager", organizationId: "o-2" });
    expect((await get()).res.status).toBe(403);
    expect((await get("s-missing")).res.status).toBe(404);
  });

  it("asks the database only for the allowlisted columns", async () => {
    as("u-trainee", { role: "trainee", organizationId: "o-1" });
    await get();
    const { select } = mocks.prisma.trainerSession.findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select).toEqual(SESSION_VIEW_SELECT);
    expect(select).not.toHaveProperty("realtimeModel");
    expect(select).not.toHaveProperty("engineTier");
    expect(select).not.toHaveProperty("voiceTier");
    // organizationId is read for the access check, never returned.
    expect(Object.keys(select).sort()).toEqual([...VIEW_KEYS, "organizationId"].sort());
  });
});

describe("sessionView", () => {
  it("builds the body field by field, so unknown columns on the row never pass through", () => {
    const view = sessionView(fullRow() as unknown as SessionViewRow);
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(JSON.stringify(view)).not.toMatch(MODEL_ID_RE);
  });

  it("keeps an evaluation without a model id as is, and a null evaluation as null", () => {
    const row = { ...fullRow(), evaluation: { method: "heuristic", overallScore: 40 } } as unknown as SessionViewRow;
    expect(sessionView(row).evaluation).toEqual({ method: "heuristic", overallScore: 40 });
    expect(sessionView({ ...fullRow(), evaluation: null } as unknown as SessionViewRow).evaluation).toBeNull();
  });
});

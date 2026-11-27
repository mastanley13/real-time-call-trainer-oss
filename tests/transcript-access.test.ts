import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * Debrief and logbook reads must stay on the signed-in user. GET /api/transcripts/[id]
 * already covers the allowlisted 403 in transcript-view.test.ts, but that file mocks
 * requireAuth, so it would not notice a missing login check, and GET /voice plus the
 * list endpoint never asserted a peer cannot read another rep's call. This file runs
 * the real session helper.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    trainerSession: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    competitionEntry: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { GET as getOne } from "@/app/api/transcripts/[id]/route";
import { GET as getVoice } from "@/app/api/transcripts/[id]/voice/route";
import { GET as listSessions } from "@/app/api/transcripts/route";
import { signSessionToken } from "@/lib/auth";
import { SESSION_VIEW_SELECT, VOICE_USED_SELECT } from "@/lib/sessionView";

const KEY = "test-secret-0123456789abcdef0123456789";
const MODEL_ID_RE = /\b(?:[Gg][Pp][Tt]-[\w.-]+|o[34](?:-[\w-]+)?|whisper-1|tts-1(?:-hd)?|gemini-[\w.-]+|eleven_\w+|claude-[\w.-]+)\b/;

type Actor = {
  id: string;
  role: string;
  isPlatformAdmin: boolean;
  organizationId: string | null;
};

type SessionRow = {
  id: string;
  userId: string;
  organizationId: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioCategory: string;
  scenarioDifficulty: string;
  durationSeconds: number;
  transcript: { role: string; text: string }[];
  evaluation: { method: string; graderVersion: string; model: string; overallScore: number };
  overallScore: number;
  grade: string;
  goalAchieved: boolean;
  supervisorNotes: string | null;
  supervisorNotesBy: string | null;
  supervisorNotesAt: Date | null;
  createdAt: Date;
  voiceTier: "premium" | "standard" | null;
  allowanceId: string | null;
  engineTier: string;
  realtimeModel: string | null;
};

const actors = new Map<string, Actor>();
const sessions: SessionRow[] = [];

const owned: SessionRow = {
  id: "s-ours",
  userId: "u-trainee",
  organizationId: "o-1",
  scenarioId: "home-services-inbound-lead",
  scenarioTitle: "Leaking water heater",
  scenarioCategory: "home-services",
  scenarioDifficulty: "medium",
  durationSeconds: 90,
  transcript: [{ role: "user", text: "How old is the unit?" }],
  evaluation: { method: "llm", graderVersion: "llm-v2", model: "gpt-4.1-mini", overallScore: 71 },
  overallScore: 71,
  grade: "C",
  goalAchieved: false,
  supervisorNotes: "Ask about the leak first.",
  supervisorNotesBy: "Mia Chen",
  supervisorNotesAt: new Date("2026-11-02T09:00:00Z"),
  createdAt: new Date("2026-11-01T10:05:13Z"),
  voiceTier: "premium",
  allowanceId: "a-1",
  engineTier: "premium",
  realtimeModel: "gpt-realtime-2.1",
};

const theirs: SessionRow = {
  ...owned,
  id: "s-theirs",
  userId: "u-other",
  organizationId: "o-2",
  supervisorNotes: "Other team's private note.",
  realtimeModel: "gpt-realtime-2.1-mini",
};

let n = 0;
const ip = () => `198.51.80.${(++n % 250) + 1}`;

function hostedOff() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

function headers(extra: Record<string, string> = {}) {
  return { "x-forwarded-for": ip(), ...extra };
}

function cookieFor(id: string, role: Actor["role"] = "trainee") {
  return { cookie: `authToken=${signSessionToken({ id, email: `${id}@example.test`, role: role as "trainee" | "manager" | "owner" })}` };
}

function seedActor(partial: Actor) {
  actors.set(partial.id, partial);
}

function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

const getSession = (id: string, extra: Record<string, string> = {}) =>
  getOne(new NextRequest(`http://localhost/api/transcripts/${id}`, { headers: headers(extra) }), { params: Promise.resolve({ id }) });

const voiceOf = (id: string, extra: Record<string, string> = {}) =>
  getVoice(new NextRequest(`http://localhost/api/transcripts/${id}/voice`, { headers: headers(extra) }), { params: Promise.resolve({ id }) });

const listOf = (extra: Record<string, string> = {}) =>
  listSessions(new NextRequest("http://localhost/api/transcripts", { headers: headers(extra) }));

beforeEach(() => {
  hostedOff();
  n = 0;
  actors.clear();
  sessions.splice(0, sessions.length, { ...owned }, { ...theirs });
  seedActor({ id: "u-trainee", role: "trainee", isPlatformAdmin: false, organizationId: "o-1" });
  seedActor({ id: "u-peer", role: "trainee", isPlatformAdmin: false, organizationId: "o-1" });
  seedActor({ id: "u-manager", role: "manager", isPlatformAdmin: false, organizationId: "o-1" });
  seedActor({ id: "u-owner", role: "owner", isPlatformAdmin: false, organizationId: "o-1" });
  seedActor({ id: "u-elsewhere", role: "manager", isPlatformAdmin: false, organizationId: "o-2" });
  seedActor({ id: "u-other", role: "trainee", isPlatformAdmin: false, organizationId: "o-2" });
  seedActor({ id: "u-admin", role: "trainee", isPlatformAdmin: true, organizationId: "o-other" });

  mocks.prisma.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { id: string } }) =>
    actors.get(where.id) ?? null);
  mocks.prisma.trainerSession.findUnique.mockReset().mockImplementation(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
    const row = sessions.find((s) => s.id === where.id);
    return row ? pick(row, select) : null;
  });
  mocks.prisma.trainerSession.findMany.mockReset().mockImplementation(async ({ where }: { where: { userId?: string; NOT?: { transcript: { equals: unknown[] } } } }) =>
    sessions.filter((s) => {
      if (where.userId && s.userId !== where.userId) return false;
      if (where.NOT?.transcript) return Array.isArray(s.transcript) && s.transcript.length > 0;
      return true;
    }));
  mocks.prisma.competitionEntry.findFirst.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/transcripts/[id] hosted auth", () => {
  it("returns 401 Authentication required without a session, and does not read the row", async () => {
    const res = await getSession("s-ours");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(mocks.prisma.trainerSession.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid or expired session for an expired cookie", async () => {
    const token = jwt.sign({ id: "u-trainee", email: "u-trainee@example.test" }, KEY, { expiresIn: -10 });
    const res = await getSession("s-ours", { cookie: `authToken=${token}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(mocks.prisma.trainerSession.findUnique).not.toHaveBeenCalled();
  });

  it("still refuses another trainee in the same org with a real session cookie", async () => {
    const peer = await getSession("s-ours", cookieFor("u-peer"));
    const peerText = await peer.text();
    expect(peer.status).toBe(403);
    expect(JSON.parse(peerText)).toEqual({ error: "Forbidden" });
    expect(peerText).not.toMatch(/gpt-|transcript|voiceUsed|premium/);
  });
});

describe("GET /api/transcripts/[id]/voice access", () => {
  it("returns 401 without a session, and does not read the row", async () => {
    const res = await voiceOf("s-ours");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(mocks.prisma.trainerSession.findUnique).not.toHaveBeenCalled();
  });

  it("the trainee who owns the session gets the voice label, never the model", async () => {
    const res = await voiceOf("s-ours", cookieFor("u-trainee"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ voiceUsed: "premium" });
    expect(text).not.toMatch(MODEL_ID_RE);
    expect(mocks.prisma.trainerSession.findUnique.mock.calls[0][0].select).toEqual(VOICE_USED_SELECT);
  });

  it("a manager of the session's organization gets the same label", async () => {
    const res = await voiceOf("s-ours", cookieFor("u-manager", "manager"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voiceUsed: "premium" });
  });

  it("an owner of the session's organization gets the same label", async () => {
    const res = await voiceOf("s-ours", cookieFor("u-owner", "owner"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voiceUsed: "premium" });
  });

  it("a platform admin gets the label even when their stored role is trainee", async () => {
    const res = await voiceOf("s-ours", cookieFor("u-admin"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voiceUsed: "premium" });
  });

  it("still refuses another trainee in the same org and a manager of another org", async () => {
    const peer = await voiceOf("s-ours", cookieFor("u-peer"));
    const peerText = await peer.text();
    expect(peer.status).toBe(403);
    expect(JSON.parse(peerText)).toEqual({ error: "Forbidden" });
    expect(peerText).not.toMatch(/voiceUsed|gpt-|premium/);

    const elsewhere = await voiceOf("s-ours", cookieFor("u-elsewhere", "manager"));
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ error: "Forbidden" });
  });

  it("asks the database only for the voice-used columns", async () => {
    await voiceOf("s-ours", cookieFor("u-trainee"));
    const { select } = mocks.prisma.trainerSession.findUnique.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(select).toEqual(VOICE_USED_SELECT);
    expect(select).not.toHaveProperty("realtimeModel");
    expect(select).not.toHaveProperty("transcript");
    expect(SESSION_VIEW_SELECT).not.toHaveProperty("voiceTier");
  });
});

describe("GET /api/transcripts list scoping", () => {
  it("returns 401 without a session, and does not list rows", async () => {
    const res = await listOf();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(mocks.prisma.trainerSession.findMany).not.toHaveBeenCalled();
  });

  it("lists only the signed-in user's sessions, even when another org has a higher score", async () => {
    const res = await listOf(cookieFor("u-trainee"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { sessions: { id: string }[] };
    expect(body.sessions.map((s) => s.id)).toEqual(["s-ours"]);
    expect(text).not.toContain("s-theirs");
    expect(text).not.toContain("Other team's private note.");
    expect(text).not.toMatch(MODEL_ID_RE);
    expect(mocks.prisma.trainerSession.findMany.mock.calls[0][0].where).toMatchObject({ userId: "u-trainee" });
  });
});

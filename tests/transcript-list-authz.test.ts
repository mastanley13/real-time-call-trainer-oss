import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

/**
 * GET /api/transcripts lists only the signed-in user's rows. GET /api/transcripts/[id] is 401 without a
 * session. Peer 403 on [id] is covered in transcript-view.test.ts with a stubbed requireAuth; this file
 * runs the real cookie check.
 */
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { signSessionToken } from "@/lib/auth";
import { GET as listTranscripts } from "@/app/api/transcripts/route";
import { GET as getTranscript } from "@/app/api/transcripts/[id]/route";

const JWT = "fixture-only-not-a-secret-0123456789abcdef";
const MAR10 = new Date("2026-03-10T12:00:00Z");
const LIST_KEYS = [
  "createdAt", "durationSeconds", "goalAchieved", "grade", "graderLlmFailed", "graderMethod", "graderVersion",
  "id", "overallScore", "scenarioCategory", "scenarioId", "scenarioTitle", "voiceUsed",
].sort();

let fake: ReturnType<typeof createFakePrisma>;

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
  vi.stubEnv("JWT_SECRET", JWT);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const cookie = (id: string, role: "trainee" | "manager" | "owner" = "trainee") =>
  `authToken=${signSessionToken({ id, email: `${id}@example.test`, role })}`;

const seedCall = (id: string, userId: string, organizationId: string, extra: Record<string, unknown> = {}) =>
  fake.seed("trainerSession", {
    id,
    userId,
    organizationId,
    scenarioId: "quote-follow-up",
    scenarioTitle: `${id} title`,
    scenarioCategory: "home-services",
    durationSeconds: 40,
    transcript: [{ role: "user", text: "Hi" }, { role: "assistant", text: "Hello" }],
    overallScore: 70,
    grade: "C",
    createdAt: MAR10,
    ...extra,
  });

const list = (headers: Record<string, string> = {}) =>
  listTranscripts(new NextRequest("http://localhost/api/transcripts", { headers }));

const getOne = (id: string, headers: Record<string, string> = {}) =>
  getTranscript(new NextRequest(`http://localhost/api/transcripts/${id}`, { headers }), { params: Promise.resolve({ id }) });

describe("GET /api/transcripts lists only the signed-in user's rows", () => {
  it("no cookie: 401", async () => {
    const res = await list();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Authentication required");
  });

  it("a forged cookie: 401", async () => {
    const res = await list({ cookie: "authToken=not-a-session" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid or expired session");
  });

  it("omits a peer's sessions, including when the actor is a manager of the same org", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
    fake.seed("user", { id: "u-owner", email: "u-owner@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: MAR10 });
    fake.seed("user", { id: "u-peer", email: "u-peer@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: MAR10 });
    fake.seed("user", { id: "u-manager", email: "u-manager@example.test", organizationId: "org-1", role: "manager", usageAnchorAt: MAR10 });
    seedCall("s-owner", "u-owner", "org-1", { voiceTier: "standard" });
    seedCall("s-peer", "u-peer", "org-1", { voiceTier: "premium", overallScore: 91, grade: "A" });
    seedCall("s-manager", "u-manager", "org-1");

    const ownerRes = await list({ cookie: cookie("u-owner") });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as { sessions: { id: string }[] };
    expect(ownerBody.sessions.map((s) => s.id)).toEqual(["s-owner"]);
    expect(Object.keys(ownerBody.sessions[0]).sort()).toEqual(LIST_KEYS);

    const managerRes = await list({ cookie: cookie("u-manager", "manager") });
    expect(managerRes.status).toBe(200);
    const managerBody = (await managerRes.json()) as { sessions: { id: string }[] };
    expect(managerBody.sessions.map((s) => s.id)).toEqual(["s-manager"]);
  });
});

describe("GET /api/transcripts/[id] authentication", () => {
  it("no cookie: 401 and the row is not returned", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
    seedCall("s-owner", "u-owner", "org-1");
    const res = await getOne("s-owner");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; session?: unknown };
    expect(body.error).toBe("Authentication required");
    expect(body.session).toBeUndefined();
  });

  it("the owner with a real cookie reads their row; a peer trainee gets 403", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
    fake.seed("user", { id: "u-owner", email: "u-owner@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: MAR10 });
    fake.seed("user", { id: "u-peer", email: "u-peer@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: MAR10 });
    seedCall("s-owner", "u-owner", "org-1");

    const own = await getOne("s-owner", { cookie: cookie("u-owner") });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { session: { id: string } }).session.id).toBe("s-owner");

    const peer = await getOne("s-owner", { cookie: cookie("u-peer") });
    expect(peer.status).toBe(403);
    expect((await peer.json()).error).toBe("Forbidden");
  });
});

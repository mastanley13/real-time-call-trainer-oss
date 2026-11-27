import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * PATCH /api/competition is the signed-in write for a public handle. GET is public and already covered
 * through getCompetitionStatus; this file runs the route with a real session cookie so a missing login
 * check, a demo-user write, or a peer overwriting someone else's name would fail.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    competitionEntry: { updateMany: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { PATCH } from "@/app/api/competition/route";
import { signSessionToken } from "@/lib/auth";

const KEY = "test-secret-0123456789abcdef0123456789";
type Entry = { id: string; userId: string; seasonSlug: string; displayName: string; teamLabel: string | null };

const entries: Entry[] = [];
let n = 0;
const ip = () => `198.51.90.${(++n % 250) + 1}`;

function hostedOff() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("COMPETITION_ENABLED", "true");
  vi.stubEnv("COMPETITION_SLUG", "launch-2026");
  vi.stubEnv("RATE_LIMIT_COMPETITION_MAX", "");
}

function cookieFor(id: string, role: "trainee" | "manager" | "owner" = "trainee") {
  return `authToken=${signSessionToken({ id, email: `${id}@example.test`, role })}`;
}

function patch(body: unknown, extra: Record<string, string> = {}, forwardedFor = ip()) {
  return PATCH(new NextRequest("http://localhost/api/competition", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      ...extra,
    },
  }));
}

beforeEach(() => {
  hostedOff();
  n = 0;
  entries.splice(0, entries.length,
    { id: "e-1", userId: "u-1", seasonSlug: "launch-2026", displayName: "Fictional Rep", teamLabel: null },
    { id: "e-2", userId: "u-peer", seasonSlug: "launch-2026", displayName: "Other Rep", teamLabel: "Apex Auto" },
  );
  mocks.prisma.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "u-1" || where.id === "u-peer" ? { id: where.id, firstName: "Fictional", lastName: "Person", email: `${where.id}@example.test` } : null);
  mocks.prisma.competitionEntry.findMany.mockReset().mockResolvedValue([]);
  mocks.prisma.competitionEntry.count.mockReset().mockResolvedValue(0);
  mocks.prisma.competitionEntry.updateMany.mockReset().mockImplementation(async ({ where, data }: { where: { seasonSlug?: string; userId?: string }; data: Partial<Entry> }) => {
    const found = entries.filter((r) => (!where.seasonSlug || r.seasonSlug === where.seasonSlug) && (!where.userId || r.userId === where.userId));
    found.forEach((r) => Object.assign(r, data));
    return { count: found.length };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PATCH /api/competition hosted auth", () => {
  it("returns 401 Authentication required without a session, and does not write", async () => {
    const res = await patch({ displayName: "Alex Example" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(mocks.prisma.competitionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid or expired session for an expired cookie", async () => {
    const token = jwt.sign({ id: "u-1", email: "u-1@example.test" }, KEY, { expiresIn: -10 });
    const res = await patch({ displayName: "Alex Example" }, { cookie: `authToken=${token}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(mocks.prisma.competitionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("refuses the demo user without writing", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await patch({ displayName: "Alex Example" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "competition_requires_account", message: "Sign in to edit your competition profile." });
    expect(mocks.prisma.competitionEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/competition sanitization", () => {
  it("returns 400 invalid_request for a missing display name, a too-long name, and malformed JSON", async () => {
    const cookie = { cookie: cookieFor("u-1") };
    expect((await patch({}, cookie)).status).toBe(400);
    expect(await (await patch({}, cookie)).json()).toEqual({ error: "invalid_request", message: "Enter a display name and an optional team label." });
    expect((await patch({ displayName: "A".repeat(41) }, cookie)).status).toBe(400);
    expect((await patch("{", cookie)).status).toBe(400);
    expect(mocks.prisma.competitionEntry.updateMany).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_profile when the public name or team still looks like an email", async () => {
    const cookie = { cookie: cookieFor("u-1") };
    expect(await (await patch({ displayName: "rep@example.test" }, cookie)).json()).toEqual({
      error: "invalid_profile",
      message: "Enter a display name without an email address.",
    });
    expect((await patch({ displayName: "Alex Example", teamLabel: "team@example.test" }, cookie)).status).toBe(400);
    expect((await patch({ displayName: " \u0000  " }, cookie)).status).toBe(400);
    expect(mocks.prisma.competitionEntry.updateMany).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({ displayName: "Fictional Rep", teamLabel: null });
  });

  it("strips control characters, collapses spaces, and stores a blank team as null", async () => {
    const res = await patch({ displayName: "  Alex\u0000   Example  ", teamLabel: "  " }, { cookie: cookieFor("u-1") });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ displayName: "Alex Example", teamLabel: null });
    expect(mocks.prisma.competitionEntry.updateMany).toHaveBeenCalledWith({
      where: { seasonSlug: "launch-2026", userId: "u-1" },
      data: { displayName: "Alex Example", teamLabel: null },
    });
    expect(entries[0]).toMatchObject({ displayName: "Alex Example", teamLabel: null });
    expect(entries[1]).toMatchObject({ displayName: "Other Rep", teamLabel: "Apex Auto" });
  });
});

describe("PATCH /api/competition org scoping", () => {
  it("writes only the signed-in user's season rows, even when a peer in the same season has a cookie", async () => {
    const res = await patch({ displayName: "Sam R.", teamLabel: "Harbor Solar" }, { cookie: cookieFor("u-peer") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ displayName: "Sam R.", teamLabel: "Harbor Solar" });
    expect(mocks.prisma.competitionEntry.updateMany.mock.calls[0][0].where).toEqual({ seasonSlug: "launch-2026", userId: "u-peer" });
    expect(entries[0]).toMatchObject({ userId: "u-1", displayName: "Fictional Rep", teamLabel: null });
    expect(entries[1]).toMatchObject({ userId: "u-peer", displayName: "Sam R.", teamLabel: "Harbor Solar" });
  });

  it("returns 429 with Retry-After when the competition write limit is 1", async () => {
    vi.stubEnv("RATE_LIMIT_COMPETITION_MAX", "1");
    entries.push({ id: "e-rate", userId: "u-rate", seasonSlug: "launch-2026", displayName: "Rate Rep", teamLabel: null });
    const cookie = { cookie: cookieFor("u-rate") };
    const sameIp = "203.0.113.77";
    expect((await patch({ displayName: "First Save" }, cookie, sameIp)).status).toBe(200);
    const limited = await patch({ displayName: "Second Save" }, cookie, sameIp);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(entries.find((e) => e.userId === "u-rate")).toMatchObject({ displayName: "First Save" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    auditEvent: { create: vi.fn() },
    consumedMfaChallenge: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  verifyTotp: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/mfa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mfa")>()),
  verifyTotp: mocks.verifyTotp,
}));

import { POST as challengeRoute } from "@/app/api/auth/mfa/challenge/route";
import { signMfaChallengeToken, verifyMfaChallenge } from "@/lib/auth";

type Row = { id: string; googleSub: string | null; lockedUntil: Date | null; mfaLastTotpStep: number | null };
const row = (patch: Partial<Row> = {}): Row => ({ id: "u-1", googleSub: null, lockedUntil: null, mfaLastTotpStep: null, ...patch });
const user = (r: Row) => ({
  ...r, email: "rep@example.test", firstName: "Ravi", lastName: "Shah", role: "owner",
  mfaEnabled: true, mfaSecret: "SECRET", isPlatformAdmin: false, organization: null,
});
const post = (token: string, code = "123456") =>
  challengeRoute(new NextRequest("http://localhost/api/auth/mfa/challenge", { method: "POST", body: JSON.stringify({ challengeToken: token, code }) }));

const googleLinkCalls = () =>
  mocks.prisma.user.updateMany.mock.calls.filter((c) => "googleSub" in ((c[0] as { data?: Record<string, unknown> }).data ?? {}));

/** An in-memory row that honours updateMany's where clause, so a lost race really returns count 0. */
function fakeDb(initial: Row) {
  const state = { ...initial };
  const usedJtis = new Set<string>();
  mocks.prisma.user.findUnique.mockImplementation(async () => user({ ...state }));
  mocks.prisma.user.update.mockImplementation(async () => user({ ...state }));
  mocks.prisma.consumedMfaChallenge.create.mockImplementation(async ({ data }: { data: { id: string; expiresAt: Date } }) => {
    if (usedJtis.has(data.id)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
    }
    usedJtis.add(data.id);
    return data;
  });
  mocks.prisma.user.updateMany.mockImplementation(async ({ where, data }: {
    where: { id: string; googleSub?: null; OR?: unknown[] };
    data: { googleSub?: string; mfaLastTotpStep?: number };
  }) => {
    if (typeof data.mfaLastTotpStep === "number") {
      if (state.mfaLastTotpStep != null && state.mfaLastTotpStep >= data.mfaLastTotpStep) return { count: 0 };
      state.mfaLastTotpStep = data.mfaLastTotpStep;
      return { count: 1 };
    }
    const unlocked = !state.lockedUntil || state.lockedUntil <= new Date();
    if (where.id !== state.id || where.googleSub !== null || state.googleSub !== null || !unlocked) return { count: 0 };
    state.googleSub = data.googleSub ?? state.googleSub;
    return { count: 1 };
  });
  return state;
}

describe("deferred Google link on MFA", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", "test-secret-0123456789abcdef0123456789");
    for (const m of [
      mocks.prisma.user.findUnique,
      mocks.prisma.user.update,
      mocks.prisma.user.updateMany,
      mocks.prisma.auditEvent.create,
      mocks.prisma.consumedMfaChallenge.create,
      mocks.prisma.$transaction,
      mocks.verifyTotp,
    ]) m.mockReset();
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => unknown) => fn(mocks.prisma));
    mocks.verifyTotp.mockReturnValue(1_700_000_000);
  });

  it("a plain challenge carries no link and never touches googleSub", async () => {
    expect(verifyMfaChallenge(signMfaChallengeToken("u-1"))).toMatchObject({ id: "u-1", linkGoogleSub: undefined });
    fakeDb(row());
    const res = await post(signMfaChallengeToken("u-1"));
    expect(res.status).toBe(200);
    expect(googleLinkCalls()).toHaveLength(0);
  });

  it("writes googleSub atomically only after the code is accepted, and issues the session", async () => {
    const state = fakeDb(row());
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("authToken=");
    expect(state.googleSub).toBe("g-sub-1");
    expect(googleLinkCalls()[0][0].where).toMatchObject({ id: "u-1", googleSub: null });
  });

  it("does not link on a wrong code", async () => {
    mocks.verifyTotp.mockReturnValue(null);
    const state = fakeDb(row());
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(401);
    expect(state.googleSub).toBeNull();
    expect(mocks.prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["locked meanwhile", { lockedUntil: new Date(Date.now() + 60_000) }],
    ["linked to a different Google account meanwhile", { googleSub: "someone-else" }],
  ] as [string, Partial<Row>][])("rejects the challenge, with no session or cookie, when the account is %s", async (_n, patch) => {
    const state = fakeDb(row(patch));
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(409);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).not.toHaveProperty("token");
    expect(state.googleSub).toBe(patch.googleSub ?? null);
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("two concurrent completions for different Google ids: one wins, the other gets no session", async () => {
    const state = fakeDb(row());
    let step = 1_700_000_000;
    mocks.verifyTotp.mockImplementation(() => ++step);
    const [a, b] = await Promise.all([post(signMfaChallengeToken("u-1", "g-sub-A")), post(signMfaChallengeToken("u-1", "g-sub-B"))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.headers.get("set-cookie")).toBeNull();
    expect(["g-sub-A", "g-sub-B"]).toContain(state.googleSub);
    const winner = a.status === 200 ? "g-sub-A" : "g-sub-B";
    expect(state.googleSub).toBe(winner);
  });

  it("a database error on the link refuses the challenge", async () => {
    fakeDb(row());
    const inner = mocks.prisma.user.updateMany.getMockImplementation()!;
    mocks.prisma.user.updateMany.mockImplementation(async (args) => {
      if ("googleSub" in (args.data ?? {})) throw new Error("unique constraint");
      return inner(args);
    });
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(409);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

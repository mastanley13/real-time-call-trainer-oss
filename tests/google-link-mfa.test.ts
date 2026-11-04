import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() }, auditEvent: { create: vi.fn() } },
  verifyTotp: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/mfa", () => ({ verifyTotp: mocks.verifyTotp }));

import { POST as challengeRoute } from "@/app/api/auth/mfa/challenge/route";
import { signMfaChallengeToken, verifyMfaChallenge } from "@/lib/auth";

const user = (patch: Record<string, unknown> = {}) => ({
  id: "u-1", email: "rep@example.test", firstName: "Ravi", lastName: "Shah", role: "owner", googleSub: null,
  mfaEnabled: true, mfaSecret: "SECRET", lockedUntil: null, isPlatformAdmin: false, organization: null, ...patch,
});
const post = (token: string, code = "123456") =>
  challengeRoute(new NextRequest("http://localhost/api/auth/mfa/challenge", { method: "POST", body: JSON.stringify({ challengeToken: token, code }) }));
const linkWrites = () => mocks.prisma.user.update.mock.calls.filter(([a]) => "googleSub" in a.data);

describe("deferred Google link on MFA", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", "test-secret-0123456789abcdef0123456789");
    for (const m of [mocks.prisma.user.findUnique, mocks.prisma.user.update, mocks.prisma.auditEvent.create, mocks.verifyTotp]) m.mockReset();
    mocks.prisma.user.findUnique.mockResolvedValue(user());
    mocks.prisma.user.update.mockResolvedValue(user());
  });

  it("a plain challenge carries no link", () => {
    expect(verifyMfaChallenge(signMfaChallengeToken("u-1"))).toEqual({ id: "u-1", linkGoogleSub: undefined });
  });

  it("writes googleSub only after the code is accepted", async () => {
    mocks.verifyTotp.mockReturnValue(true);
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(200);
    expect(linkWrites()).toHaveLength(1);
    expect(linkWrites()[0][0]).toMatchObject({ where: { id: "u-1" }, data: { googleSub: "g-sub-1" } });
  });

  it("does not link on a wrong code", async () => {
    mocks.verifyTotp.mockReturnValue(false);
    const res = await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(res.status).toBe(401);
    expect(linkWrites()).toHaveLength(0);
  });

  it("does not link over an existing Google id or onto a locked account", async () => {
    mocks.verifyTotp.mockReturnValue(true);
    mocks.prisma.user.findUnique.mockResolvedValue(user({ googleSub: "someone-else" }));
    await post(signMfaChallengeToken("u-1", "g-sub-1"));
    mocks.prisma.user.findUnique.mockResolvedValue(user({ lockedUntil: new Date(Date.now() + 60_000) }));
    await post(signMfaChallengeToken("u-1", "g-sub-1"));
    expect(linkWrites()).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Google and the database are the only fakes; the callback route runs for real.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn(), create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  flow: { state: "s", verifier: "v", nonce: "n", next: "/trainer" } as Record<string, unknown>,
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/googleAuth", () => ({
  GOOGLE_FLOW_COOKIE: "g_oauth",
  flowCookieOptions: {},
  googleConfig: () => ({ clientId: "cid" }),
  verifyFlowState: () => mocks.flow,
  exchangeCode: async () => ({ idToken: "t" }),
  decodeIdToken: () => ({}),
  checkIdTokenClaims: () => ({
    ok: true,
    profile: { sub: "sub-1", email: "ada@example.test", firstName: "Ada", lastName: "Lovelace" },
  }),
}));

import { GET } from "@/app/api/auth/google/callback/route";
import { googleSignupParams } from "@/lib/googleSignup";

let ipCounter = 0;
function callback() {
  ipCounter += 1;
  return new NextRequest("http://localhost/api/auth/google/callback?code=abc&state=s", {
    headers: { "x-forwarded-for": `203.0.113.${ipCounter}` },
  });
}

describe("Google signup button params", () => {
  it("sends the code the person typed, not the invite code", () => {
    const invite = { code: "111111", manager: "mgr-1" };
    expect(googleSignupParams("join", "222222", invite)).toEqual({ intent: "solo", code: "222222" });
  });

  it("sends the typed code when there is no invite", () => {
    expect(googleSignupParams("join", " 482913 ", null)).toEqual({ intent: "solo", code: "482913" });
  });

  it("keeps the invite manager only while the code still matches", () => {
    const invite = { code: "111111", manager: "mgr-1" };
    expect(googleSignupParams("join", "111111", invite)).toEqual({ intent: "solo", code: "111111", manager: "mgr-1" });
  });

  it("sends no code in solo or create mode", () => {
    const invite = { code: "111111", manager: "mgr-1" };
    expect(googleSignupParams("solo", "111111", invite)).toEqual({ intent: "solo" });
    expect(googleSignupParams("create", "111111", invite)).toEqual({ intent: "team" });
  });
});

describe("Google callback with a join code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flow = { state: "s", verifier: "v", nonce: "n", next: "/trainer", joinCode: "999999", intent: "solo" };
    mocks.prisma.user.findUnique.mockResolvedValue(null);
  });

  async function rejects() {
    const res = await GET(callback());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=invalid_join_code");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("session");
    expect(mocks.prisma.organization.create).not.toHaveBeenCalled();
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  }

  it("rejects an unknown code instead of creating a personal workspace", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue(null);
    await rejects();
  });

  it("rejects a personal workspace code", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-p", isPersonal: true });
    await rejects();
  });
});

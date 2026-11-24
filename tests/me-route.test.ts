import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { GET } from "@/app/api/me/route";
import { signSessionToken } from "@/lib/auth";

const KEY = "test-secret-0123456789abcdef0123456789";

const secrets = {
  passwordHash: "$2b$12$not-a-real-hash-and-must-not-leak",
  mfaSecret: "JBSWY3DPEHPK3PXP",
  googleSub: "google-sub-should-stay-server-side",
  stripeCustomerId: "cus_test_should_not_leak",
  stripeSubscriptionId: "sub_test_should_not_leak",
};

const org = {
  id: "org-1",
  name: "Harbor Point",
  code: "329927",
  planTier: "team",
  sessionRetentionDays: 90,
  stripeCustomerId: "cus_org_should_not_leak",
};

const trainee = {
  id: "u-rep",
  email: "rep@example.test",
  firstName: "Ravi",
  lastName: "Shah",
  role: "trainee" as const,
  isPlatformAdmin: false,
  mfaEnabled: true,
  mfaEnrolledAt: new Date("2026-10-01T00:00:00.000Z"),
  organizationId: org.id,
  organization: org,
  ...secrets,
};

function hostedOff() {
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("NODE_ENV", "production");
}

function req(extra: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/me", { headers: extra });
}

beforeEach(() => {
  hostedOff();
  mocks.prisma.user.findUnique.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/me invite-code payload", () => {
  it("returns 401 without a session when demo mode is off", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid or expired session for an expired token, and does not load the user", async () => {
    const token = jwt.sign({ id: trainee.id, email: trainee.email, role: "trainee" }, KEY, { expiresIn: -10 });
    const res = await GET(req({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("gives a trainee the standing team code the invite panel copies, without password, MFA or billing secrets", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(trainee);
    const token = signSessionToken({ id: trainee.id, email: trainee.email, role: "trainee" });
    const res = await GET(req({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      user: Record<string, unknown>;
      organization: { id: string; name: string; code: string };
    };
    expect(body.user).toMatchObject({
      id: "u-rep",
      email: "rep@example.test",
      firstName: "Ravi",
      lastName: "Shah",
      role: "trainee",
      isPlatformAdmin: false,
      mfaEnabled: true,
    });
    expect(body.organization).toEqual({
      id: "org-1",
      name: "Harbor Point",
      code: "329927",
      planTier: "team",
      sessionRetentionDays: 90,
    });
    const text = JSON.stringify(body);
    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
    expect(text).not.toContain("cus_org_should_not_leak");
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u-rep" },
      include: { organization: true },
    });
  });

  it("returns 404 when the session user is gone from the database", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    const token = signSessionToken({ id: "missing", email: "gone@example.test" });
    const res = await GET(req({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "User not found" });
  });
});

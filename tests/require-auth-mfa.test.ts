import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Only the database is fake: the real token check and the real requireAuth run.
const mocks = vi.hoisted(() => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { requireAuth } from "@/lib/apiAuth";
import { signSessionToken } from "@/lib/auth";

const saved = { JWT_SECRET: process.env.JWT_SECRET, DEMO_MODE: process.env.DEMO_MODE, DATABASE_URL: process.env.DATABASE_URL };
beforeEach(() => {
  process.env.JWT_SECRET = "test-secret-0123456789abcdef0123456789";
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  delete process.env.DEMO_MODE;
  mocks.prisma.user.findUnique.mockReset();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

// One token, issued before any policy existed. It is never reissued in these tests.
const token = () => signSessionToken({ id: "u1", email: "u1@example.test", role: "trainee" });
const req = () => new NextRequest("http://localhost/api/x", { headers: { authorization: `Bearer ${token()}` } });
const row = (mfaEnabled: boolean, org: { requireMfa?: boolean; mfaGraceEndsAt?: Date | null } | null) =>
  mocks.prisma.user.findUnique.mockResolvedValue({ mfaEnabled, organization: org && { requireMfa: false, mfaGraceEndsAt: null, ...org } });
const status = async (r: Awaited<ReturnType<typeof requireAuth>>) => (r instanceof NextResponse ? r.status : 200);

describe("requireAuth org MFA policy, read from the database on every call", () => {
  it("lets a session issued before enforcement through while the org does not require MFA", async () => {
    row(false, {});
    expect(await requireAuth(req())).toMatchObject({ id: "u1" });
  });

  it("blocks that same session once enforcement is turned on", async () => {
    row(false, { requireMfa: true });
    const res = await requireAuth(req());
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(403);
    expect(await (res as NextResponse).json()).toMatchObject({ error: "mfa_enrollment_required" });
  });

  it("blocks it when the grace period ends, and not before", async () => {
    row(false, { requireMfa: true, mfaGraceEndsAt: new Date(Date.now() + 60_000) });
    expect(await status(await requireAuth(req()))).toBe(200);
    row(false, { requireMfa: true, mfaGraceEndsAt: new Date(Date.now() - 60_000) });
    expect(await status(await requireAuth(req()))).toBe(403);
  });

  it("blocks an enrolled member's old session after a support reset clears their MFA", async () => {
    row(true, { requireMfa: true });
    expect(await status(await requireAuth(req()))).toBe(200);
    row(false, { requireMfa: true });
    expect(await status(await requireAuth(req()))).toBe(403);
  });

  it("restores access without a new login when a manager turns enforcement off", async () => {
    row(false, { requireMfa: true });
    expect(await status(await requireAuth(req()))).toBe(403);
    row(false, { requireMfa: false });
    expect(await status(await requireAuth(req()))).toBe(200);
  });

  it("restores access once the member enrols", async () => {
    row(false, { requireMfa: true });
    expect(await status(await requireAuth(req()))).toBe(403);
    row(true, { requireMfa: true });
    expect(await status(await requireAuth(req()))).toBe(200);
  });

  it("still lets enrollment routes through for a blocked member, without a policy lookup", async () => {
    row(false, { requireMfa: true });
    expect(await requireAuth(req(), { allowMfaEnrollment: true })).toMatchObject({ id: "u1" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not restrict users with no organization", async () => {
    row(false, null);
    expect(await status(await requireAuth(req()))).toBe(200);
  });

  it("rejects a session whose user no longer exists, and fails closed when the lookup breaks", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    expect(await status(await requireAuth(req()))).toBe(401);
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await status(await requireAuth(req()))).toBe(503);
    spy.mockRestore();
  });

  it("skips the lookup without a database and in demo mode", async () => {
    delete process.env.DATABASE_URL;
    expect(await requireAuth(req())).toMatchObject({ id: "u1" });
    process.env.DATABASE_URL = "postgresql://test@localhost/test";
    process.env.DEMO_MODE = "true";
    expect(await requireAuth(new NextRequest("http://localhost/api/x"))).toMatchObject({ id: "demo-user" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("still returns 401 for a missing or bad token before touching the database", async () => {
    expect(await status(await requireAuth(new NextRequest("http://localhost/api/x")))).toBe(401);
    expect(await status(await requireAuth(new NextRequest("http://localhost/api/x", { headers: { authorization: "Bearer nope" } })))).toBe(401);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

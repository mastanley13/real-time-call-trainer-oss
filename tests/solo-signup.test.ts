import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database is the only fake; the register and login routes run for real.
const mocks = vi.hoisted(() => {
  const prisma = {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn(), create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma };
});
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { hashPassword } from "@/lib/auth";
import { personalOrgName } from "@/lib/orgCodes";

const PASSWORD = "correct horse battery";
// Orgs the fake database "stores", so user.create can return the include.
const orgs = new Map<string, Record<string, unknown>>();
let ipCounter = 0;

function post(url: string, body: unknown) {
  // A fresh IP per call keeps the in-memory rate limit out of the way.
  ipCounter += 1;
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${ipCounter}` },
    body: JSON.stringify(body),
  });
}

const base = { firstName: "Ada", lastName: "Lovelace", email: "Ada@Example.test", password: PASSWORD };

const saved = { JWT_SECRET: process.env.JWT_SECRET, TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS };
beforeEach(() => {
  process.env.JWT_SECRET = "test-only-secret-0123456789abcdef0123";
  process.env.TRUSTED_PROXY_HOPS = "1";
  vi.clearAllMocks();
  mocks.prisma.$transaction.mockImplementation((fn: (tx: typeof mocks.prisma) => unknown) => fn(mocks.prisma));
  mocks.prisma.user.findUnique.mockResolvedValue(null);
  orgs.clear();
  mocks.prisma.organization.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    const org = { id: "org-1", isPersonal: false, ...data };
    orgs.set("org-1", org);
    return Promise.resolve(org);
  });
  mocks.prisma.user.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "user-1",
      isPlatformAdmin: false,
      ...data,
      organization: { id: data.organizationId, name: "n", code: "123456", planTier: "free", isPersonal: false, ...(orgs.get(data.organizationId as string) ?? {}) },
    }),
  );
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("register", () => {
  it("signs up with only name, email and password into a personal Free org", async () => {
    const res = await register(post("/api/auth/register", base));
    expect(res.status).toBe(200);
    const body = await res.json();

    const orgData = mocks.prisma.organization.create.mock.calls[0][0].data;
    expect(orgData).toMatchObject({ name: "Ada Lovelace", planTier: "free", isPersonal: true });
    expect(orgData.code).toMatch(/^[0-9]{6}$/);

    const userData = mocks.prisma.user.create.mock.calls[0][0].data;
    expect(userData).toMatchObject({ email: "ada@example.test", organizationId: "org-1", role: "trainee" });
    expect(userData.onboardedAt).toBeInstanceOf(Date);

    // The code is generated but never shown, and no onboarding detour.
    expect(body.organization).toMatchObject({ isPersonal: true, code: null });
    expect(body.needsOnboarding).toBe(false);
  });

  it("records joinOrCreate: solo in the audit event", async () => {
    await register(post("/api/auth/register", base));
    const audit = mocks.prisma.auditEvent.create.mock.calls[0][0].data;
    expect(audit.action).toBe("user.registered");
    expect(audit.metadata.joinOrCreate).toBe("solo");
  });

  it("still creates a team with newOrgName", async () => {
    const res = await register(post("/api/auth/register", { ...base, newOrgName: "Harbor Point" }));
    expect(res.status).toBe(200);
    expect(mocks.prisma.organization.create.mock.calls[0][0].data).toMatchObject({ name: "Harbor Point" });
    expect(mocks.prisma.organization.create.mock.calls[0][0].data.isPersonal).toBeUndefined();
    expect(mocks.prisma.user.create.mock.calls[0][0].data.role).toBe("owner");
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data.metadata.joinOrCreate).toBe("create");
    expect((await res.json()).needsOnboarding).toBe(true);
  });

  it("still joins an org with a valid joinOrgCode", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-9", code: "123456", name: "Harbor Point", isPersonal: false });
    const res = await register(post("/api/auth/register", { ...base, joinOrgCode: "123456" }));
    expect(res.status).toBe(200);
    expect(mocks.prisma.user.create.mock.calls[0][0].data).toMatchObject({ organizationId: "org-9", role: "trainee" });
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data.metadata.joinOrCreate).toBe("join");
  });

  it("rejects an unknown joinOrgCode", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue(null);
    const res = await register(post("/api/auth/register", { ...base, joinOrgCode: "999999" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown organization code.");
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });

  it("does not let anyone join a personal workspace with its code", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-p", code: "654321", name: "Solo", isPersonal: true });
    const res = await register(post("/api/auth/register", { ...base, joinOrgCode: "654321" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unknown organization code.");
  });

  it("rejects both joinOrgCode and newOrgName", async () => {
    const res = await register(post("/api/auth/register", { ...base, joinOrgCode: "123456", newOrgName: "Harbor Point" }));
    expect(res.status).toBe(400);
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
  });
});

describe("personalOrgName", () => {
  it("uses the name, else the email local part", () => {
    expect(personalOrgName({ firstName: " Ada ", lastName: "Lovelace", email: "a@b.test" })).toBe("Ada Lovelace");
    expect(personalOrgName({ firstName: null, lastName: null, email: "ada.l@b.test" })).toBe("ada.l");
  });
});

describe("login", () => {
  it("succeeds without an orgCode", async () => {
    const passwordHash = await hashPassword(PASSWORD);
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: "user-1", email: "ada@example.test", firstName: "Ada", lastName: "Lovelace", role: "trainee", passwordHash,
      isPlatformAdmin: false, failedLoginCount: 0, lockedUntil: null, mfaEnabled: false, mfaSecret: null,
      organizationId: "org-1", onboardedAt: new Date(),
      organization: { id: "org-1", name: "Ada Lovelace", code: "123456", isPersonal: true },
    });
    const res = await login(post("/api/auth/login", { email: "ada@example.test", password: PASSWORD }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organization).toMatchObject({ isPersonal: true, code: null });
    expect(body.needsOnboarding).toBe(false);
  });
});

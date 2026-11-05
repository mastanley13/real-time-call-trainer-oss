import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the session check are the only fakes; the route runs for real.
const mocks = vi.hoisted(() => ({
  user: { id: "mgr-1", email: "mgr@example.test" } as { id: string; email: string },
  prisma: {
    trainerSession: { findUnique: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET } from "@/app/api/transcripts/[id]/route";

const CREATED = new Date("2026-10-27T09:00:00Z");
const row = { id: "s-2", userId: "trainee-1", organizationId: "org-1", createdAt: CREATED, overallScore: 40 };
const get = (id = "s-2") => GET(new NextRequest(`http://localhost/api/transcripts/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  mocks.prisma.trainerSession.findUnique.mockReset().mockResolvedValue(row);
  mocks.prisma.trainerSession.count.mockReset().mockResolvedValue(0);
  mocks.prisma.user.findUnique.mockReset().mockResolvedValue({ id: "mgr-1", role: "manager", organizationId: "org-1", isPlatformAdmin: false });
});

describe("GET /api/transcripts/[id] firstGradedCall", () => {
  it("counts the session owner's earlier graded calls, never the viewing manager's", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).firstGradedCall).toBe(true);
    expect(mocks.prisma.trainerSession.count).toHaveBeenCalledWith({
      where: { userId: "trainee-1", id: { not: "s-2" }, overallScore: { not: null }, createdAt: { lt: CREATED } },
    });
  });

  it("is false when the owner has an earlier graded call", async () => {
    mocks.prisma.trainerSession.count.mockResolvedValue(2);
    expect((await (await get()).json()).firstGradedCall).toBe(false);
  });

  it("does not answer for a manager in another organization", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "mgr-1", role: "manager", organizationId: "org-2", isPlatformAdmin: false });
    const res = await get();
    expect(res.status).toBe(403);
    expect(mocks.prisma.trainerSession.count).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn(), user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { signSessionToken } from "@/lib/auth";
import { GET } from "@/app/api/health/route";

const SECRET = "test-jwt-secret-0123456789abcdef-long";
const req = (headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/health", { headers });
const tokenFor = (id: string) => signSessionToken({ id, email: `${id}@example.test` });

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://test");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  mocks.prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/health", () => {
  it("answers the public with only { ok }", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps 503 for uptime checks when the database is down, still without details", async () => {
    mocks.prisma.$queryRaw.mockRejectedValue(new Error("down"));
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("never reveals demo mode publicly", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const body = await (await GET(req())).json();
    expect(body).toEqual({ ok: true });
  });

  it("shows the checks with the CRON_SECRET bearer", async () => {
    const body = await (await GET(req({ authorization: "Bearer cron-test-secret" }))).json();
    expect(body.ok).toBe(true);
    expect(body.checks).toMatchObject({ db: "ok", jwtSecret: "ok", realtime: "configured", demoMode: "off" });
    expect(body.timestamp).toBeTruthy();
  });

  it("rejects a wrong secret, and any secret when CRON_SECRET is unset", async () => {
    expect(await (await GET(req({ authorization: "Bearer nope" }))).json()).toEqual({ ok: true });
    vi.stubEnv("CRON_SECRET", "");
    expect(await (await GET(req({ authorization: "Bearer " }))).json()).toEqual({ ok: true });
  });

  it("shows the checks to a signed-in platform admin, by header or cookie", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    const token = tokenFor("admin-1");
    expect((await (await GET(req({ authorization: `Bearer ${token}` }))).json()).checks).toBeTruthy();
    expect((await (await GET(req({ cookie: `authToken=${token}` }))).json()).checks).toBeTruthy();
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "admin-1" }, select: { isPlatformAdmin: true } });
  });

  it("hides the checks from a signed-in user who is not an admin", async () => {
    const body = await (await GET(req({ cookie: `authToken=${tokenFor("rep-1")}` }))).json();
    expect(body).toEqual({ ok: true });
  });

  it("never treats the demo user as an admin", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    mocks.prisma.user.findUnique.mockResolvedValue({ isPlatformAdmin: true });
    const body = await (await GET(req({ cookie: `authToken=${tokenFor("admin-1")}` }))).json();
    expect(body).toEqual({ ok: true });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("hides the checks when the admin lookup fails", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db"));
    const body = await (await GET(req({ cookie: `authToken=${tokenFor("admin-1")}` }))).json();
    expect(body).toEqual({ ok: true });
  });
});

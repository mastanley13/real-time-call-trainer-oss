import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database and the rate limiter are the only fakes; the route and the access helpers run for real.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), rateLimit: mocks.rateLimit }));

import { POST } from "@/app/api/auth/register/route";
import { ACCESS_COOKIE, accessToken } from "@/lib/access";

const CODE = "let-me-in";
const body = {
  firstName: "Mia",
  lastName: "Chen",
  email: "mia@example.test",
  password: "correct-horse-battery",
  newOrgName: "Example Team",
};

const post = (cookie?: string) =>
  POST(new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `${ACCESS_COOKIE}=${cookie}` } : {}) },
  }));

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-only-secret-0123456789abcdef");
  vi.stubEnv("TRAINER_ACCESS_CODE", "");
  mocks.rateLimit.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  mocks.prisma.user.findUnique.mockReset().mockResolvedValue({ id: "u-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/auth/register access gate", () => {
  it("returns 403 when the gate is set and there is no cookie", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite code required" });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when the cookie is wrong", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post("not-the-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite code required" });
  });

  it("proceeds when the cookie is valid", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
    const res = await post(await accessToken(CODE));
    expect(res.status).toBe(409);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledOnce();
  });

  it("proceeds without a cookie when the gate is unset", async () => {
    const res = await post();
    expect(res.status).toBe(409);
  });
});

describe("POST /api/auth/register database failures", () => {
  it("returns a JSON 500 when the email lookup throws", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Registration failed. Please try again." });
  });
});

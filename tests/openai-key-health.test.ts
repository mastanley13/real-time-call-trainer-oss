import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/cron/openai-keys: who may read OpenAI key slot health, the exact response shape, and that a read has no
 * side effects. The real session check runs (with a test-only JWT secret); only the database is faked.
 */

const mocks = vi.hoisted(() => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { GET } from "@/app/api/cron/openai-keys/route";
import { signSessionToken } from "@/lib/auth";
import { chatFull } from "@/lib/llm";
import { OPENAI_KEY_SLOT_VARS, openAiKeyHealth, resetOpenAiKeyState } from "@/lib/openaiKeys";
import { proxy } from "@/proxy";

const hex = (n: number) => randomBytes(n).toString("hex");
const KEYS = [0, 1, 2].map((i) => `${hex(8)}fixturekeyslot${i}${hex(8)}`);
const CRON = `fixture-cron-${hex(12)}`;
const JWT = "fixture-only-not-a-secret-0123456789abcdef";
const ENV = ["DEMO_MODE", "DATABASE_URL", "JWT_SECRET", "CRON_SECRET", "LLM_API_KEY", "LLM_BASE_URL", "OPENAI_REALTIME_API_KEY", "TRAINER_ACCESS_CODE", "STRIPE_SECRET_KEY", ...OPENAI_KEY_SLOT_VARS] as const;
const TOP_KEYS = ["chat", "lastFailover", "realtime", "scope", "slots"];

let n = 0;
let outputs: string[] = [];
beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("JWT_SECRET", JWT);
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("OPENAI_API_KEY", KEYS[0]);
  vi.stubEnv("OPENAI_API_KEY_BACKUP_2", KEYS[2]);
  resetOpenAiKeyState();
  mocks.prisma.user.findUnique.mockReset();
  outputs = [];
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void outputs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ip = () => `198.51.100.${(++n % 250) + 1}`;
const get = async (headers: Record<string, string> = {}) => {
  const res = await GET(new NextRequest("http://localhost/api/cron/openai-keys", { headers: { "x-forwarded-for": ip(), ...headers } }));
  const text = await res.text();
  outputs.push(text);
  return { res, text, body: JSON.parse(text) as Record<string, unknown> };
};
/** A signed-in user; the fake database answers whether they are a platform admin. */
const as = (role: "trainee" | "manager" | "owner", isPlatformAdmin: boolean) => {
  const id = `kh-${role}-${++n}`;
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === id ? { isPlatformAdmin } : null));
  return { cookie: `authToken=${signSessionToken({ id, email: `${id}@example.test`, role })}` };
};

describe("GET /api/cron/openai-keys authorization", () => {
  it("no session: 401", async () => {
    const { res } = await get();
    expect(res.status).toBe(401);
  });

  it.each(["owner", "manager", "trainee"] as const)("a signed-in %s who is not a platform admin: 403", async (role) => {
    const { res, body } = await get(as(role, false));
    expect(res.status).toBe(403);
    expect(body.error).toBe("forbidden");
  });

  it("a platform admin: 200 with no-store", async () => {
    const { res, body } = await get(as("owner", true));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(TOP_KEYS);
  });

  it("the correct cron bearer: 200 without a database lookup", async () => {
    const { res, body } = await get({ authorization: `Bearer ${CRON}` });
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(TOP_KEYS);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("a wrong bearer, x-vercel-cron alone, or no CRON_SECRET: 401", async () => {
    expect((await get({ authorization: `Bearer ${CRON}x` })).res.status).toBe(401);
    expect((await get({ authorization: "Bearer not-the-secret" })).res.status).toBe(401);
    expect((await get({ "x-vercel-cron": "1" })).res.status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await get({ authorization: "Bearer " })).res.status).toBe(401);
  });

  it("demo mode: 404", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { res } = await get({ authorization: `Bearer ${CRON}` });
    expect(res.status).toBe(404);
  });

  it("no database: a signed-in user gets 403, cron still works", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect((await get(as("owner", true))).res.status).toBe(403);
    expect((await get({ authorization: `Bearer ${CRON}` })).res.status).toBe(200);
  });

  it("over 30 a minute: 429 with Retry-After", async () => {
    const admin = as("owner", true);
    const from = "198.51.100.254";
    for (let i = 0; i < 30; i++) {
      const res = await GET(new NextRequest("http://localhost/api/cron/openai-keys", { headers: { "x-forwarded-for": from, ...admin } }));
      expect(res.status).toBe(200);
    }
    const res = await GET(new NextRequest("http://localhost/api/cron/openai-keys", { headers: { "x-forwarded-for": from, ...admin } }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("is exempt from the access-code gate under /api/cron/, unlike a /api/health subpath", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "fixture-access-code");
    const gated = (path: string) => proxy(new NextRequest(`http://localhost${path}`));
    expect((await gated("/api/cron/openai-keys")).status).toBe(200);
    expect((await gated("/api/health/openai-keys")).status).toBe(401);
  });
});

describe("GET /api/cron/openai-keys response", () => {
  const cron = { authorization: `Bearer ${CRON}` };

  it("has the exact shape: slot numbers and states, booleans, no key bytes", async () => {
    const { body, text } = await get(cron);
    expect(body).toEqual({
      scope: "this_instance",
      slots: [
        { slot: 0, configured: true, state: "unknown", exhaustedAt: null, lastOkAt: null },
        { slot: 1, configured: false, state: "not_configured" },
        { slot: 2, configured: true, state: "unknown", exhaustedAt: null, lastOkAt: null },
      ],
      realtime: { explicitKey: false },
      chat: { explicitKey: false, openAiBase: true },
      lastFailover: null,
    });
    for (const k of KEYS) {
      expect(text).not.toContain(k.slice(0, 6));
      expect(text).not.toContain(k.slice(-6));
    }
  });

  it("reports explicit keys as booleans only, and a custom base without the URL", async () => {
    vi.stubEnv("OPENAI_REALTIME_API_KEY", `${hex(8)}fixturert${hex(8)}`);
    vi.stubEnv("LLM_API_KEY", `${hex(8)}fixturellm${hex(8)}`);
    vi.stubEnv("LLM_BASE_URL", "https://llm.custom-fixture.example/v1");
    const { body, text } = await get(cron);
    expect(body.realtime).toEqual({ explicitKey: true });
    expect(body.chat).toEqual({ explicitKey: true, openAiBase: false });
    expect(text).not.toMatch(/fixturert|fixturellm|custom-fixture/);
  });

  it("a GET makes no fetch and changes no state, after a real failover", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = String((init.headers as Record<string, string>).Authorization);
      return auth.endsWith(KEYS[0])
        ? new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429 })
        : Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await chatFull([{ role: "user", content: "hi" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const before = JSON.stringify(openAiKeyHealth());

    fetchMock.mockClear();
    const { body } = await get(cron);
    await get(cron);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(openAiKeyHealth())).toBe(before);
    expect(body.slots).toEqual([
      { slot: 0, configured: true, state: "quota_exhausted", exhaustedAt: expect.any(String), lastOkAt: null },
      { slot: 1, configured: false, state: "not_configured" },
      { slot: 2, configured: true, state: "ok", exhaustedAt: null, lastOkAt: expect.any(String) },
    ]);
    expect(body.lastFailover).toEqual({ from: 0, to: 2, surface: "chat", at: expect.any(String) });
    expect(Object.keys(body.lastFailover as object).sort()).toEqual(["at", "from", "surface", "to"]);
  });

  it("nothing logged or returned carries key bytes or the cron secret", async () => {
    await get(cron);
    await get(as("owner", true));
    const all = outputs.join("\n");
    for (const k of KEYS) {
      expect(all).not.toContain(k.slice(0, 6));
      expect(all).not.toContain(k.slice(-6));
    }
    expect(all).not.toContain(CRON);
  });
});

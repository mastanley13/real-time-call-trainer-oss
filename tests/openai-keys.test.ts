import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// STR-690: plan -> OpenAI key routing. The database, the session check and the metering ledger are faked; key
// selection, BYOK encryption and the route handlers run for real, and fetch is mocked so no request leaves.
const mocks = vi.hoisted(() => ({
  user: { id: "free-1", email: "free-1@example.test" } as { id: string; email: string },
  /** Plan rows by user id, as planContextFor selects them. */
  plans: new Map<string, unknown>(),
  /** The actor row loadActor and managesOrgOf read. */
  actor: null as unknown,
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    trainerSession: { findUnique: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  beginCall: vi.fn(),
  endCall: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: (u: { id: string }) => u.id === "demo-user" }));
vi.mock("@/lib/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/usage")>()), beginCall: mocks.beginCall, endCall: mocks.endCall }));

import { anyKeyFor, openAiKeyFor, pickKey, planContextFor } from "@/lib/openaiKeys";
import { BYOK_KEY_PATTERN, byokEncryptionKey, decryptByok, encryptByok } from "@/lib/byok";
import { openAiTierStatus } from "@/lib/serverConfig";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as simulateTurn } from "@/app/api/simulate/turn/route";
import { POST as coachTurnRoute } from "@/app/api/coach/turn/route";
import { POST as evaluateRoute } from "@/app/api/evaluate-call/route";
import { POST as personaGenerate } from "@/app/api/persona/generate/route";
import { POST as llmCheck } from "@/app/api/llm/check/route";
import { PATCH as regrade } from "@/app/api/transcripts/[id]/route";
import { DELETE as byokDelete, GET as byokGet, PUT as byokPut } from "@/app/api/team/openai-key/route";
import { GET as health } from "@/app/api/health/route";

const FREE_KEY = "sk-test-free-0000000000000000";
const PAID_KEY = "sk-test-paid-1111111111111111";
const SHARED_KEY = "sk-test-shared-2222222222222222";
const BYOK_KEY = "sk-test-byok-team-3333333333333333";
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");
const ALL_KEYS = [FREE_KEY, PAID_KEY, SHARED_KEY, BYOK_KEY];

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;

const ENV_KEYS = [
  "OPENAI_API_KEY_FREE", "OPENAI_API_KEY_PAID", "OPENAI_API_KEY", "OPENAI_REALTIME_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL",
  "DATABASE_URL", "DEMO_MODE", "STRIPE_SECRET_KEY", "USAGE_CAPS", "BYOK_ENCRYPTION_KEY", "JWT_SECRET",
  "RATE_LIMIT_GRADING_MAX", "RATE_LIMIT_REALTIME_MAX", "RATE_LIMIT_CALLER_MAX", "RATE_LIMIT_COACH_MAX", "RATE_LIMIT_WIZARD_MAX", "RATE_LIMIT_BILLING_MAX",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/** Everything written to the console during a test, so we can prove no key was logged. */
let logged: string[] = [];
let n = 0;
const signIn = (id: string) => (mocks.user = { id, email: `${id}@example.test` });

const freeUser = { planTier: "free", organization: null };
const proUser = { planTier: "pro", organization: null };
const teamUser = (ciphertext: string | null = null, planTier = "team") => ({ planTier: "free", organization: { id: "org-team", planTier, openaiKeyCiphertext: ciphertext } });

/** Each test gets fresh user ids so the per-user rate limits never carry over. */
function users() {
  n += 1;
  const ids = { free: `free-${n}`, pro: `pro-${n}`, team: `team-${n}`, byok: `byok-${n}` };
  mocks.plans.set(ids.free, freeUser);
  mocks.plans.set(ids.pro, proUser);
  mocks.plans.set(ids.team, teamUser());
  mocks.plans.set(ids.byok, teamUser(encryptByok(BYOK_KEY, "org-team", Buffer.from(ENC_KEY, "base64"))));
  return ids;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // A stored-account deployment with Stripe test billing on, so Pro and Team are real paid plans.
  process.env.DATABASE_URL = "postgresql://ci:ci@localhost:5432/ci";
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_stripe_key";
  process.env.OPENAI_API_KEY_FREE = FREE_KEY;
  process.env.OPENAI_API_KEY_PAID = PAID_KEY;
  process.env.BYOK_ENCRYPTION_KEY = ENC_KEY;
  process.env.LLM_MODEL = "gpt-test-mini";
  for (const scope of ["GRADING", "REALTIME", "CALLER", "COACH", "WIZARD", "BILLING"]) process.env[`RATE_LIMIT_${scope}_MAX`] = "100000";

  mocks.plans.clear();
  mocks.actor = null;
  for (const group of Object.values(mocks.prisma)) {
    if (typeof group === "function") group.mockReset();
    else for (const fn of Object.values(group)) fn.mockReset();
  }
  mocks.prisma.user.findUnique.mockImplementation(async (args: { where: { id: string }; select?: Record<string, unknown> }) =>
    args.select && "planTier" in args.select ? (mocks.plans.get(args.where.id) ?? null) : mocks.actor,
  );
  mocks.prisma.auditEvent.create.mockResolvedValue({});
  mocks.beginCall.mockReset().mockResolvedValue({ ok: true, callId: "call-1", engine: "premium", maxSeconds: 600 });
  mocks.endCall.mockReset().mockResolvedValue(null);

  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The key-never-logged rule holds for every test in this file, whatever it exercised.
  for (const line of logged) for (const key of ALL_KEYS) expect(line).not.toContain(key);
});

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${n % 250}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  });

/** Records the bearer token of every outbound fetch and answers like OpenAI would. */
function mockOpenAi() {
  const auths: string[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    auths.push(String((init.headers as Record<string, string>).Authorization));
    if (String(url).endsWith("/realtime/client_secrets")) return Response.json({ value: "ek_test_secret_123", expires_at: 1_900_000_000 });
    if (String(url).endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "Sure, tell me more." }, finish_reason: "stop" }] });
    return new Response("not mocked", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return auths;
}

const expectNoKeys = (text: string) => {
  for (const key of ALL_KEYS) expect(text).not.toContain(key);
};

// ---------------------------------------------------------------------------------------------------------------

describe("pickKey: plan -> key", () => {
  const tiered = { OPENAI_API_KEY_FREE: FREE_KEY, OPENAI_API_KEY_PAID: PAID_KEY };

  it("sends free users to the free project and paid users to the paid project, for voice and LLM", () => {
    for (const kind of ["realtime", "llm"] as const) {
      expect(pickKey({ tier: "free" }, kind, tiered)).toEqual({ key: FREE_KEY, project: "free", shared: false });
      expect(pickKey({ tier: "paid" }, kind, tiered)).toEqual({ key: PAID_KEY, project: "paid", shared: false });
    }
  });

  it("uses a Team's own key ahead of the paid key", () => {
    expect(pickKey({ tier: "paid", byokKey: BYOK_KEY }, "realtime", tiered)).toEqual({ key: BYOK_KEY, project: "byok", shared: false });
    expect(pickKey({ tier: "paid", byokKey: BYOK_KEY }, "llm", tiered)).toEqual({ key: BYOK_KEY, project: "byok", shared: false });
  });

  it("keeps a single-key install working: with no tier keys both tiers use the shared key", () => {
    const single = { OPENAI_API_KEY: SHARED_KEY };
    expect(pickKey({ tier: "free" }, "realtime", single)).toEqual({ key: SHARED_KEY, project: "free", shared: true });
    expect(pickKey({ tier: "paid" }, "llm", single)).toEqual({ key: SHARED_KEY, project: "paid", shared: true });
    // The existing realtime-only override still applies to voice.
    expect(pickKey({ tier: "free" }, "realtime", { OPENAI_REALTIME_API_KEY: "sk-test-rt-override-000000", OPENAI_API_KEY: SHARED_KEY })?.key).toBe("sk-test-rt-override-000000");
  });

  it("never gives a free user the paid key", () => {
    // Only PAID set, nothing shared: free has no key at all (voice 503, LLM jobs on their rules-based fallbacks).
    expect(pickKey({ tier: "free" }, "realtime", { OPENAI_API_KEY_PAID: PAID_KEY })).toBeNull();
    expect(pickKey({ tier: "free" }, "llm", { OPENAI_API_KEY_PAID: PAID_KEY })).toBeNull();
    // Only PAID set plus a shared key: free falls back to the shared key, paid keeps its own.
    expect(pickKey({ tier: "free" }, "llm", { OPENAI_API_KEY_PAID: PAID_KEY, OPENAI_API_KEY: SHARED_KEY })).toEqual({ key: SHARED_KEY, project: "free", shared: true });
    expect(pickKey({ tier: "paid" }, "llm", { OPENAI_API_KEY_PAID: PAID_KEY, OPENAI_API_KEY: SHARED_KEY })?.key).toBe(PAID_KEY);
    // The shared key is the paid key pasted twice: still refused for free.
    for (const kind of ["realtime", "llm"] as const) {
      expect(pickKey({ tier: "free" }, kind, { OPENAI_API_KEY_PAID: PAID_KEY, OPENAI_API_KEY: PAID_KEY })).toBeNull();
      expect(pickKey({ tier: "free" }, kind, { OPENAI_API_KEY_PAID: PAID_KEY, OPENAI_REALTIME_API_KEY: PAID_KEY, LLM_API_KEY: PAID_KEY })).toBeNull();
    }
  });

  it("never spends paid traffic on the free project either", () => {
    expect(pickKey({ tier: "paid" }, "realtime", { OPENAI_API_KEY_FREE: FREE_KEY })).toBeNull();
    expect(pickKey({ tier: "paid" }, "realtime", { OPENAI_API_KEY_FREE: FREE_KEY, OPENAI_API_KEY: SHARED_KEY })).toEqual({ key: SHARED_KEY, project: "paid", shared: true });
  });

  it("never sends an OpenAI tier key or a Team key to a custom LLM base URL", () => {
    const custom = { ...tiered, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "or-test-key" };
    expect(pickKey({ tier: "paid", byokKey: BYOK_KEY }, "llm", custom)).toEqual({ key: "or-test-key", project: "custom", shared: true });
    expect(pickKey({ tier: "free" }, "llm", { ...tiered, LLM_BASE_URL: "https://openrouter.ai/api/v1" })).toBeNull();
    // Voice always goes to OpenAI, so it still routes by plan.
    expect(pickKey({ tier: "paid" }, "realtime", custom)?.key).toBe(PAID_KEY);
  });

  it("anyKeyFor is true when either tier has a key", () => {
    expect(anyKeyFor("llm", {})).toBe(false);
    expect(anyKeyFor("llm", { OPENAI_API_KEY_PAID: PAID_KEY })).toBe(true);
    expect(anyKeyFor("realtime", { OPENAI_API_KEY_FREE: FREE_KEY })).toBe(true);
  });
});

describe("planContextFor: the plan comes from the server, never the client", () => {
  it("maps Free, Pro and Team to tiers, and decrypts a Team's own key", async () => {
    const ids = users();
    expect(await planContextFor(ids.free)).toEqual({ tier: "free" });
    expect(await planContextFor(ids.pro)).toEqual({ tier: "paid" });
    expect(await planContextFor(ids.team)).toEqual({ tier: "paid" });
    expect(await planContextFor(ids.byok)).toEqual({ tier: "paid", byokKey: BYOK_KEY });
  });

  it("treats everyone as Free while billing is off, like metering does", async () => {
    const ids = users();
    delete process.env.STRIPE_SECRET_KEY;
    expect(await planContextFor(ids.pro)).toEqual({ tier: "free" });
    expect(await planContextFor(ids.byok)).toEqual({ tier: "free" });
  });

  it("ignores a stored Team key once the organization is no longer on Team", async () => {
    mocks.plans.set("lapsed", teamUser(encryptByok(BYOK_KEY, "org-team", Buffer.from(ENC_KEY, "base64")), "free"));
    expect(await planContextFor("lapsed")).toEqual({ tier: "free" });
  });

  it("uses the paid project when a Team key cannot be decrypted, and logs no key material", async () => {
    mocks.plans.set("rotated", teamUser(encryptByok(BYOK_KEY, "org-team", Buffer.alloc(32, 9))));
    expect(await planContextFor("rotated")).toEqual({ tier: "paid" });
    expect(logged.join("\n")).toMatch(/could not be decrypted/);
  });

  it("is Free for demo, database-less, unknown and unauthenticated users, and when the lookup fails", async () => {
    expect(await planContextFor(undefined)).toEqual({ tier: "free" });
    expect(await planContextFor("demo-user")).toEqual({ tier: "free" });
    expect(await planContextFor("nobody")).toEqual({ tier: "free" });
    mocks.prisma.user.findUnique.mockRejectedValueOnce(new Error("connection refused"));
    expect(await planContextFor("pro-x")).toEqual({ tier: "free" });
    delete process.env.DATABASE_URL;
    mocks.plans.set("pro-nodb", proUser);
    expect(await planContextFor("pro-nodb")).toEqual({ tier: "free" });
  });

  it("openAiKeyFor ties plan and key together", async () => {
    const ids = users();
    expect((await openAiKeyFor(ids.free, "realtime"))?.key).toBe(FREE_KEY);
    expect((await openAiKeyFor(ids.pro, "realtime"))?.key).toBe(PAID_KEY);
    expect(await openAiKeyFor(ids.byok, "llm")).toEqual({ key: BYOK_KEY, project: "byok", shared: false });
  });
});

describe("BYOK encryption", () => {
  const key = Buffer.from(ENC_KEY, "base64");

  it("round-trips, never stores the plaintext, and uses a fresh IV each time", () => {
    const a = encryptByok(BYOK_KEY, "org-1", key);
    const b = encryptByok(BYOK_KEY, "org-1", key);
    expect(a).not.toContain(BYOK_KEY);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptByok(a, "org-1", key)).toBe(BYOK_KEY);
  });

  it("refuses another organization's id, another key and a tampered blob", () => {
    const blob = encryptByok(BYOK_KEY, "org-1", key);
    expect(() => decryptByok(blob, "org-2", key)).toThrow("BYOK_DECRYPT_FAILED");
    expect(() => decryptByok(blob, "org-1", Buffer.alloc(32, 1))).toThrow("BYOK_DECRYPT_FAILED");
    const parts = blob.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 1;
    expect(() => decryptByok([parts[0], parts[1], parts[2], ct.toString("base64url")].join("."), "org-1", key)).toThrow("BYOK_DECRYPT_FAILED");
    expect(() => decryptByok("v2.a.b.c", "org-1", key)).toThrow("BYOK_BAD_FORMAT");
  });

  it("needs a 32-byte BYOK_ENCRYPTION_KEY", () => {
    expect(byokEncryptionKey({})).toBeNull();
    expect(byokEncryptionKey({ BYOK_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toBeNull();
    expect(byokEncryptionKey({ BYOK_ENCRYPTION_KEY: ENC_KEY })?.length).toBe(32);
    expect(() => encryptByok(BYOK_KEY, "org-1", null)).toThrow("BYOK_NOT_CONFIGURED");
  });

  it("accepts OpenAI secret keys only", () => {
    expect(BYOK_KEY_PATTERN.test(BYOK_KEY)).toBe(true);
    expect(BYOK_KEY_PATTERN.test("sk-proj-test-not-a-real-key-000000")).toBe(true);
    expect(BYOK_KEY_PATTERN.test("pk-test-abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(BYOK_KEY_PATTERN.test("sk-short")).toBe(false);
    expect(BYOK_KEY_PATTERN.test("sk-has spaces in it 1234567890")).toBe(false);
  });
});

describe("routes send the plan's key upstream", () => {
  it("realtime session: free -> free key, paid -> paid key, Team with BYOK -> its key", async () => {
    const ids = users();
    const auths = mockOpenAi();
    for (const id of [ids.free, ids.pro, ids.byok]) {
      signIn(id);
      const res = await realtimeSession(post("/api/realtime/session", { scenario }));
      expect(res.status).toBe(200);
      expectNoKeys(await res.text());
    }
    expect(auths).toEqual([`Bearer ${FREE_KEY}`, `Bearer ${PAID_KEY}`, `Bearer ${BYOK_KEY}`]);
  });

  it("realtime session: a free user with only the paid key configured gets the 503, not the paid key", async () => {
    const ids = users();
    delete process.env.OPENAI_API_KEY_FREE;
    const auths = mockOpenAi();
    signIn(ids.free);
    const res = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("realtime_not_configured");
    expect(mocks.beginCall).not.toHaveBeenCalled();
    signIn(ids.pro);
    expect((await realtimeSession(post("/api/realtime/session", { scenario }))).status).toBe(200);
    expect(auths).toEqual([`Bearer ${PAID_KEY}`]);
  });

  it("text caller (LLM): free -> free key, paid -> paid key", async () => {
    const ids = users();
    const auths = mockOpenAi();
    for (const id of [ids.free, ids.pro]) {
      signIn(id);
      const res = await simulateTurn(post("/api/simulate/turn", { scenario, history: [{ role: "user", text: "Hi, this is Sam from the plumbing team." }] }));
      const body = await res.json();
      expect(body.source).toBe("llm");
      expectNoKeys(JSON.stringify(body));
    }
    expect(auths).toEqual([`Bearer ${FREE_KEY}`, `Bearer ${PAID_KEY}`]);
  });

  it("text caller: a free user with only the paid key falls back to the scripted caller", async () => {
    const ids = users();
    delete process.env.OPENAI_API_KEY_FREE;
    const auths = mockOpenAi();
    signIn(ids.free);
    const body = await (await simulateTurn(post("/api/simulate/turn", { scenario, history: [{ role: "user", text: "Hi there." }] }))).json();
    expect(body.source).toBe("scripted");
    expect(auths).toEqual([]);
  });

  it("coach, grading, persona wizard and the connection check all use the plan's key", async () => {
    const ids = users();
    const auths = mockOpenAi();
    signIn(ids.pro);
    await coachTurnRoute(post("/api/coach/turn", { scenario, transcript: [{ role: "user", text: "Hi, I can help with the leak today." }], allowCue: true }));
    await evaluateRoute(post("/api/evaluate-call", { scenario, transcript: [{ role: "user", text: "Hi, I can help with the leak today." }] }));
    await personaGenerate(post("/api/persona/generate", { role: "sdr", industry: "", callType: "cold", difficulty: "easy", product: "", contexts: [] }));
    signIn(ids.free);
    const check = await llmCheck(post("/api/llm/check", {}));
    expectNoKeys(await check.text());
    expect(auths).toEqual([`Bearer ${PAID_KEY}`, `Bearer ${PAID_KEY}`, `Bearer ${PAID_KEY}`, `Bearer ${FREE_KEY}`]);
  });

  it("re-grade bills the rep whose call it is, not the manager re-grading it", async () => {
    users();
    mocks.plans.set("rep-free", freeUser);
    mocks.actor = { id: "mgr-pro", role: "manager", isPlatformAdmin: false, organizationId: "org-1" };
    signIn("mgr-pro");
    mocks.plans.set("mgr-pro", proUser);
    mocks.prisma.trainerSession.findUnique.mockResolvedValue({
      id: "s-1", userId: "rep-free", organizationId: "org-1", scenarioId: scenario.id, evaluation: null, overallScore: null, updatedAt: new Date(),
      transcript: [{ role: "user", text: "Hi, I can help with the leak today." }],
    });
    mocks.prisma.$transaction.mockResolvedValue([]);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Okay.", criteria: [], strengths: [], improvements: [], goalStatus: "partial", goalExplanation: "Some progress." }) }, finish_reason: "stop" }] }, { headers: { "x-auth": String((init.headers as Record<string, string>).Authorization) } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await regrade(new NextRequest("http://localhost/api/transcripts/s-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: "s-1" }) });
    expect(res.status).toBe(200);
    expectNoKeys(await res.text());
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(`Bearer ${FREE_KEY}`);
  });

  it("no route reads a provider key itself: every OpenAI caller goes through openaiKeys.ts", () => {
    const root = join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    // Only the config readers and the resolver may touch key env vars or the global key readers.
    const allowed = new Set(["lib/serverConfig.ts", "lib/realtime.ts", "lib/openaiKeys.ts", "lib/byok.ts"]);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(root, f).split("\\").join("/");
      if (allowed.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      if (/\b(realtimeKey|llmKey|resolveLlmKey|resolveRealtimeKey)\s*\(/.test(src) || /process\.env\.(OPENAI_API_KEY|OPENAI_REALTIME_API_KEY|LLM_API_KEY|BYOK_ENCRYPTION_KEY)\b/.test(src)) offenders.push(rel);
      // Anything that calls OpenAI with a server key, or the LLM client, must resolve the key with openAiKeyFor.
      const callsOpenAi = /realtime\/client_secrets|\bchatFull\(|[^.\w]chat\(\[|\/chat\/completions/.test(src);
      if (callsOpenAi && rel.startsWith("app/") && !/openAiKeyFor\(/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("team OpenAI key route (BYOK)", () => {
  const owner = { id: "owner-1", role: "owner", isPlatformAdmin: false, organizationId: "org-team", firstName: "O", lastName: "W", email: "o@example.test" };
  const put = (body: unknown) => new NextRequest("http://localhost/api/team/openai-key", { method: "PUT", headers: { "content-type": "application/json", "x-forwarded-for": `10.8.0.${++n % 250}` }, body: JSON.stringify(body) });
  const del = () => new NextRequest("http://localhost/api/team/openai-key", { method: "DELETE", headers: { "x-forwarded-for": `10.7.0.${++n % 250}` } });
  const get = () => new NextRequest("http://localhost/api/team/openai-key");

  beforeEach(() => {
    signIn(`owner-${++n}`);
    mocks.actor = owner;
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-team", planTier: "team", openaiKeyCiphertext: null, openaiKeyLast4: null, openaiKeyUpdatedAt: null });
    mocks.prisma.organization.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      openaiKeyCiphertext: data.openaiKeyCiphertext ?? null, openaiKeyLast4: data.openaiKeyLast4 ?? null, openaiKeyUpdatedAt: data.openaiKeyUpdatedAt ?? null,
    }));
  });

  it("stores the key encrypted and returns only set, last four and the time", async () => {
    const res = await byokPut(put({ apiKey: BYOK_KEY }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expectNoKeys(text);
    const body = JSON.parse(text);
    expect(body).toEqual({ set: true, last4: BYOK_KEY.slice(-4), updatedAt: expect.any(String) });
    const stored = mocks.prisma.organization.update.mock.calls[0][0].data.openaiKeyCiphertext as string;
    expect(stored).not.toContain(BYOK_KEY);
    expect(decryptByok(stored, "org-team")).toBe(BYOK_KEY);
    const auditCall = JSON.stringify(mocks.prisma.auditEvent.create.mock.calls);
    expect(auditCall).toContain("org.openai_key_set");
    expectNoKeys(auditCall);
  });

  it("GET never returns the ciphertext or the key", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ openaiKeyCiphertext: encryptByok(BYOK_KEY, "org-team"), openaiKeyLast4: "3333", openaiKeyUpdatedAt: new Date("2026-11-01T00:00:00Z") });
    const text = await (await byokGet(get())).text();
    expect(JSON.parse(text)).toEqual({ set: true, last4: "3333", updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(text).not.toContain("v1.");
  });

  it("clears the key", async () => {
    const res = await byokDelete(del());
    expect(await res.json()).toEqual({ set: false, last4: null, updatedAt: null });
    expect(mocks.prisma.organization.update.mock.calls[0][0].data).toEqual({ openaiKeyCiphertext: null, openaiKeyLast4: null, openaiKeyUpdatedAt: null });
  });

  it("is for owners only", async () => {
    mocks.actor = { ...owner, role: "manager" };
    expect((await byokPut(put({ apiKey: BYOK_KEY }))).status).toBe(403);
    expect((await byokDelete(del())).status).toBe(403);
    expect((await byokGet(get())).status).toBe(403);
    mocks.actor = { ...owner, role: "trainee" };
    expect((await byokPut(put({ apiKey: BYOK_KEY }))).status).toBe(403);
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
  });

  it("needs the Team plan, a valid key and BYOK_ENCRYPTION_KEY, and never echoes a rejected key", async () => {
    mocks.prisma.organization.findUnique.mockResolvedValue({ id: "org-team", planTier: "free" });
    expect((await byokPut(put({ apiKey: BYOK_KEY }))).status).toBe(403);
    const bad = await byokPut(put({ apiKey: "sk-not valid but secret 123456789" }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("secret 123456789");
    delete process.env.BYOK_ENCRYPTION_KEY;
    const res = await byokPut(put({ apiKey: BYOK_KEY }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("byok_not_configured");
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
  });
});

describe("health reports configured tiers as booleans only", () => {
  it("shows which tiers have keys without exposing them", async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([1]);
    process.env.JWT_SECRET = "ci-only-not-a-secret-0123456789abcdef";
    process.env.OPENAI_API_KEY = SHARED_KEY;
    const text = await (await health()).text();
    expectNoKeys(text);
    expect(JSON.parse(text).openai).toEqual({ free: true, paid: true, shared: true, byokEncryption: true });
    expect(openAiTierStatus({})).toEqual({ free: false, paid: false, shared: false, byokEncryption: false });
    expect(openAiTierStatus({ OPENAI_API_KEY_PAID: PAID_KEY, BYOK_ENCRYPTION_KEY: "short" })).toEqual({ free: false, paid: true, shared: false, byokEncryption: false });
  });
});

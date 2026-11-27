import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import type { CustomScenario, User } from "@prisma/client";

/**
 * POST /api/persona/generate drafts a persona for the signed-in account but does
 * not write CustomScenario. Account persistence is POST /api/scenarios with that
 * draft. This file runs the real session helper and the real template generator;
 * only Prisma is faked. No network.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    customScenario: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { POST as generate } from "@/app/api/persona/generate/route";
import { POST as saveScenario } from "@/app/api/scenarios/route";
import { signSessionToken } from "@/lib/auth";
import { ScenarioSchema } from "@/lib/scenarios";
import type { WizardInput } from "@/lib/wizard-types";

const KEY = "test-secret-0123456789abcdef0123456789";
const T0 = new Date("2026-11-27T16:00:00.000Z");
const MODEL_ID_RE = /\b(?:[Gg][Pp][Tt]-[\w.-]+|o[34](?:-[\w-]+)?|whisper-1|tts-1(?:-hd)?|gemini-[\w.-]+|eleven_\w+|claude-[\w.-]+)\b/;

type Actor = Pick<User, "id" | "organizationId" | "role" | "isPlatformAdmin">;

const actors = new Map<string, Actor>();
let rows: CustomScenario[] = [];
let n = 0;

const draftInput = (): WizardInput => ({
  role: "sdr",
  industry: "Freight brokerage",
  callType: "cold",
  difficulty: "medium",
  product: "Load matching for mid-size brokerages.",
  contexts: [{ kind: "icp", text: "VP of Operations at a 50-300 person brokerage." }],
  keepRealNames: false,
});

function hostedOff() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("WIZARD_API_KEY", "");
  vi.stubEnv("WIZARD_PROVIDER", "");
  vi.stubEnv("WIZARD_MODEL", "");
  vi.stubEnv("RATE_LIMIT_WIZARD_MAX", "1000");
  vi.stubEnv("RATE_LIMIT_SCENARIOS_MAX", "1000");
}

const ip = () => `198.51.90.${(++n % 250) + 1}`;

function cookieFor(id: string, role: Actor["role"] = "trainee") {
  return { cookie: `authToken=${signSessionToken({ id, email: `${id}@example.test`, role })}` };
}

function seedActor(partial: Actor) {
  actors.set(partial.id, partial);
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...extra },
    body: JSON.stringify(body),
  });
}

const generateAs = (extra: Record<string, string> = {}, body: WizardInput = draftInput()) =>
  generate(post("/api/persona/generate", body, extra));

const saveAs = (scenario: unknown, extra: Record<string, string> = {}, keepRealNames = false) =>
  saveScenario(post("/api/scenarios", { scenario, keepRealNames }, extra));

function prismaWrites() {
  return {
    findUnique: mocks.prisma.customScenario.findUnique.mock.calls.length,
    create: mocks.prisma.customScenario.create.mock.calls.length,
    update: mocks.prisma.customScenario.update.mock.calls.length,
    tx: mocks.prisma.$transaction.mock.calls.length,
    users: mocks.prisma.user.findUnique.mock.calls.length,
  };
}

beforeEach(() => {
  hostedOff();
  n = 0;
  actors.clear();
  rows = [];
  seedActor({ id: "u-rep", role: "trainee", organizationId: "org-1", isPlatformAdmin: false });
  seedActor({ id: "u-peer", role: "trainee", organizationId: "org-1", isPlatformAdmin: false });
  const db = mocks.prisma;
  db.user.findUnique.mockReset().mockImplementation(async ({ where }: { where: { id: string } }) => actors.get(where.id) ?? null);
  db.$transaction.mockReset().mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  db.$queryRaw.mockReset().mockResolvedValue([{ locked: 1 }]);
  db.customScenario.findUnique.mockReset().mockImplementation(async ({ where }: { where: { id: string } }) =>
    rows.find((row) => row.id === where.id) ?? null);
  db.customScenario.count.mockReset().mockImplementation(async ({ where }: { where: { userId: string } }) =>
    rows.filter((row) => row.userId === where.userId).length);
  db.customScenario.create.mockReset().mockImplementation(async ({ data }: { data: CustomScenario }) => {
    const row = { ...data, createdAt: T0 };
    rows.push(row);
    return row;
  });
  db.customScenario.update.mockReset().mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<CustomScenario> }) => {
    const row = rows.find((item) => item.id === where.id)!;
    Object.assign(row, data);
    return row;
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("persona-generate-persist tests must not call fetch");
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/persona/generate does not persist", () => {
  it("the generate route module never imports the database or the save helper", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/persona/generate/route.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/db/);
    expect(src).not.toMatch(/customScenario/);
    expect(src).not.toMatch(/saveCustomScenario/);
    expect(src).not.toMatch(/prisma/);
  });

  it("returns 401 without a session and does not write a persona", async () => {
    const res = await generateAs();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(prismaWrites()).toEqual({ findUnique: 0, create: 0, update: 0, tx: 0, users: 0 });
    expect(rows).toHaveLength(0);
  });

  it("returns 401 for an expired cookie and does not write a persona", async () => {
    const token = jwt.sign({ id: "u-rep", email: "u-rep@example.test" }, KEY, { expiresIn: -10 });
    const res = await generateAs({ cookie: `authToken=${token}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(prismaWrites()).toEqual({ findUnique: 0, create: 0, update: 0, tx: 0, users: 0 });
  });

  it("drafts a template persona for a real session cookie without touching CustomScenario", async () => {
    const res = await generateAs(cookieFor("u-rep"));
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as { scenario: { id: string; builtIn: boolean; status: string }; method: string };
    expect(body.method).toBe("template");
    expect(body).not.toHaveProperty("model");
    expect(text).not.toMatch(MODEL_ID_RE);
    expect(ScenarioSchema.safeParse(body.scenario).success).toBe(true);
    expect(body.scenario).toMatchObject({ builtIn: false, status: "draft", role: "sdr" });
    expect(body.scenario.id).toMatch(/^custom-[a-z0-9]+-[a-z0-9]{1,4}$/);
    expect(prismaWrites()).toEqual({ findUnique: 0, create: 0, update: 0, tx: 0, users: 0 });
    expect(rows).toHaveLength(0);
  });
});

describe("account save is POST /api/scenarios", () => {
  it("persists the generated draft on the signed-in account", async () => {
    const drafted = await generateAs(cookieFor("u-rep"));
    const { scenario } = await drafted.json() as { scenario: { id: string } };
    expect(rows).toHaveLength(0);

    const saved = await saveAs(scenario, cookieFor("u-rep"), false);
    expect(saved.status).toBe(201);
    const { item } = await saved.json();
    expect(item).toMatchObject({
      userId: "u-rep",
      organizationId: "org-1",
      sharedWithOrg: false,
      keepRealNames: false,
      canEdit: true,
      scenario: { id: scenario.id, builtIn: false, status: "draft" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: scenario.id, userId: "u-rep", keepRealNames: false });
    expect(mocks.prisma.customScenario.create).toHaveBeenCalledOnce();
  });

  it("rejects a peer who POSTs the same generated id after the owner saved it", async () => {
    const drafted = await generateAs(cookieFor("u-rep"));
    const { scenario } = await drafted.json() as { scenario: { id: string } };
    expect((await saveAs(scenario, cookieFor("u-rep"))).status).toBe(201);

    const peer = await saveAs(scenario, cookieFor("u-peer"));
    expect(peer.status).toBe(409);
    expect(await peer.json()).toMatchObject({ error: "id_conflict" });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("u-rep");
    expect(mocks.prisma.customScenario.update).not.toHaveBeenCalled();
  });

  it("demo mode drafts without a cookie and refuses account save without writing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DEMO_MODE", "true");
    const drafted = await generateAs();
    expect(drafted.status).toBe(200);
    const { scenario, method } = await drafted.json() as { scenario: { id: string }; method: string };
    expect(method).toBe("template");
    expect(prismaWrites()).toEqual({ findUnique: 0, create: 0, update: 0, tx: 0, users: 0 });

    const saved = await saveAs(scenario);
    expect(saved.status).toBe(503);
    expect(await saved.json()).toMatchObject({ error: "database_not_configured" });
    expect(prismaWrites()).toEqual({ findUnique: 0, create: 0, update: 0, tx: 0, users: 0 });
    expect(rows).toHaveLength(0);
  });
});

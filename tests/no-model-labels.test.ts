import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkHint } from "@/app/api/llm/hints";
import { GET as configGET } from "@/app/api/config/route";
import { POST as llmCheckPOST } from "@/app/api/llm/check/route";
import { jobRows, voiceEngines } from "@/components/settings/models";
import { graderLabel } from "@/lib/grader-types";
import { VOICE_ENGINE_LABELS, realtimeUpstreamMessage } from "@/lib/realtime";
import { VOICE_TIER_LABELS } from "@/lib/voiceTier";

/**
 * Users must never see a model id. Model ids live only in server config and API routes; every UI module (pages,
 * components, contexts, client copy) stays free of them, comments included, so a label can't creep back in.
 * Provider names are a different matter: this is the self-hosted build, and "OpenAI" and "ElevenLabs" tell the
 * operator which key to set, so they stay.
 */
const MODEL_ID_PATTERNS = [
  /gpt-4\.1[\w.-]*/i, /GPT 4\.1/i, /gpt-4o[\w.-]*/i, /gpt-5[\w.-]*/i, /gpt-realtime[\w.-]*/i,
  /\bo[34](?:-[a-z0-9]+)*\b/, /whisper-1/i, /tts-1[\w.-]*/i, /gemini-[\w.-]+/i, /eleven_[a-z0-9_]+/i, /claude-[a-z0-9.-]+/i,
];
const hasModelId = (text: string) => MODEL_ID_PATTERNS.some((re) => re.test(text));

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

/** Server-only modules allowed to hold backend model ids. No UI file belongs here. */
const SERVER_ALLOWLIST = [
  /^src\/lib\/serverConfig\.ts$/, /^src\/lib\/realtime\.ts$/, /^src\/lib\/llm\.ts$/, /^src\/app\/api\/.+\/route\.ts$/,
  // Voice tier to model id map ("server-only"). The client-safe tier names and labels in voiceTier.ts hold no ids.
  /^src\/lib\/voiceModels\.ts$/,
];

/** UI roots: everything under these is rendered or ships to the browser. */
const UI_ROOTS = ["src/app", "src/components", "src/contexts"];
/** Client-safe copy modules outside the UI roots whose strings reach the screen. */
const UI_COPY_MODULES = [
  "src/app/api/llm/hints.ts", "src/lib/grader-types.ts", "src/lib/format.ts", "src/lib/modelChip.ts", "src/lib/voiceTier.ts",
  "src/lib/landing.ts", "src/lib/pricing.ts", "src/lib/billingUi.ts", "src/lib/usageResponses.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|mjs|json|md)$/.test(name) ? [full] : [];
  });
}

function hits(file: string): string[] {
  const out: string[] = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const re of MODEL_ID_PATTERNS) if (re.test(line)) out.push(`${rel(file)}:${i + 1} ${line.trim()}`);
  });
  return out;
}

const isApiRoute = (r: string) => r.startsWith("src/app/api/");

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("no model ids in the UI", () => {
  it("keeps UI source free of model ids", () => {
    const uiFiles = UI_ROOTS.flatMap((r) => walk(path.join(ROOT, r))).filter((f) => !isApiRoute(rel(f)));
    expect(uiFiles.length).toBeGreaterThan(20);
    const found = [...uiFiles, ...UI_COPY_MODULES.map((m) => path.join(ROOT, m))].flatMap(hits);
    expect(found).toEqual([]);
  });

  it("only lets server-only modules hold model ids", () => {
    const offenders = walk(SRC).flatMap(hits).filter((h) => !SERVER_ALLOWLIST.some((re) => re.test(h.split(":")[0])));
    expect(offenders).toEqual([]);
    // The allowlist can't be used to smuggle a UI file in.
    for (const re of SERVER_ALLOWLIST) {
      for (const ui of ["src/components/SiteHeader.tsx", "src/app/page.tsx", "src/contexts/AuthContext.tsx", "src/app/api/llm/hints.ts", "src/lib/voiceTier.ts"]) {
        expect(re.test(ui)).toBe(false);
      }
    }
  });

  it("catches a reintroduced label, old and new model families alike", () => {
    for (const sample of [
      '<span className="chip-model">gpt-4.1-mini (default)</span>', "Voice · gpt-realtime-1.5", "gpt-realtime-2.1-mini", "gpt-4.1-nano", "gpt-5-mini",
      "gpt-4o-mini-transcribe", "o3", "o4-mini", "o3-pro", "whisper-1", "tts-1-hd", "gemini-2.5-flash", "eleven_turbo_v2_5", "claude-sonnet-4-5",
    ]) expect(hasModelId(sample), sample).toBe(true);
    for (const fine of ["AI coach", "OpenAI Realtime", "ElevenLabs", "Standard", "Premium", "Voice", "Configured", "co3", "Top 3", "H4"]) {
      expect(hasModelId(fine), fine).toBe(false);
    }
  });

  it("display helpers never return a raw model id, whatever the server reports, and keep provider names", () => {
    const model = "gpt-4.1-mini";
    const caps = { llm: true, model, realtime: "gpt-realtime-1.5", realtimeModel: "gpt-realtime-1.5", voiceEngines: ["openai", "elevenlabs"] };
    const shown = [
      ...jobRows(caps).map((j) => j.engine),
      ...voiceEngines(caps).flatMap((v) => [v.label, v.setup, JSON.stringify(v)]),
      graderLabel({ method: "llm" }),
      ...Object.values(VOICE_ENGINE_LABELS),
      ...Object.values(VOICE_TIER_LABELS),
      ...[200, 400, 401, 403, 404, 429, 500].flatMap((s) => [realtimeUpstreamMessage(s), checkHint({ ok: s === 200, status: s })]),
    ];
    for (const text of shown) expect(hasModelId(text), text).toBe(false);
    expect(jobRows(caps).every((j) => j.engine === "AI")).toBe(true);
    // OSS keeps provider names for self-hosters.
    expect(VOICE_ENGINE_LABELS).toEqual({ openai: "OpenAI Realtime", elevenlabs: "ElevenLabs" });
    expect(voiceEngines(caps).map((v) => v.label)).toEqual(["OpenAI Realtime", "ElevenLabs voice agent"]);
  });
});

/** Every env var that names a model, set to ids the payloads must never echo. */
function stubModelEnv() {
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("LLM_API_KEY", "sk-llm-test-not-real");
  vi.stubEnv("LLM_BASE_URL", "");
  vi.stubEnv("LLM_MODEL", "gpt-5-mini");
  vi.stubEnv("OPENAI_API_KEY", "sk-openai-test-not-real");
  vi.stubEnv("REALTIME_MODEL", "gpt-realtime-2.1-mini");
  vi.stubEnv("REALTIME_MODEL_STANDARD", "gpt-realtime-2.1-mini");
  vi.stubEnv("REALTIME_MODEL_PREMIUM", "gpt-realtime-2.1");
  vi.stubEnv("REALTIME_TRANSCRIBE_MODEL", "whisper-1");
  vi.stubEnv("ELEVENLABS_API_KEY", "xi-test-not-real");
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-test");
}

describe("public API payloads carry no model ids", () => {
  it("GET /api/config sends booleans and the provider name, never model or realtimeModel", async () => {
    stubModelEnv();
    const res = await configGET();
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ llm: true, realtime: true, elevenlabs: true, provider: "openai" });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("realtimeModel");
    expect(hasModelId(text)).toBe(false);
    expect(text).not.toMatch(/sk-llm|sk-openai|xi-test/);
  });

  it("POST /api/llm/check still calls upstream with LLM_MODEL but returns no model id", async () => {
    stubModelEnv();
    for (const [status, payload] of [[200, { choices: [{ message: { content: "O" } }] }], [404, { error: "gpt-5-mini not found" }], [500, {}]] as const) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await llmCheckPOST(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": `10.7.0.${status % 250}` } }));
      const text = await res.text();
      expect(res.status).toBe(200);
      const body = JSON.parse(text);
      expect(Object.keys(body).sort()).toEqual(["hint", "latencyMs", "ok", "status"]);
      expect(hasModelId(text), text).toBe(false);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body)).model).toBe("gpt-5-mini");
    }
  });
});

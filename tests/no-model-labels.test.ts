import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The open-source build never shows a model id to users: not on pages, not in /api/config (unauthenticated), not in
 * /api/llm/check, and not in errors. Provider names (OpenAI, ElevenLabs) stay. Model ids live only in the backend
 * defaults (serverConfig.ts, realtime.ts) and the env, and go upstream in provider requests.
 */

// Only the session check is faked, so the config and connection-check routes run for real.
const mocks = vi.hoisted(() => ({ user: { id: "nml-0", email: "nml@example.test" } }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user }));

import { GET as configGET } from "@/app/api/config/route";
import { POST as checkPOST } from "@/app/api/llm/check/route";
import { POST as sessionPOST } from "@/app/api/realtime/session/route";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import Home from "@/app/page";
import { brand } from "@/lib/tenant";
/** Model id families, shared with the tenant schema's copy check (src/lib/modelIds.ts). */
import { MODEL_ID_RE } from "@/lib/modelIds";

/**
 * Backend defaults that must stay: they are sent to providers, never rendered or returned. Exact files, no globs.
 * src/lib/voiceModels.ts is the server-only voice tier to Realtime model mapping; it must stay server-only (checked below).
 */
const BACKEND_ALLOWLIST = new Set(["src/lib/serverConfig.ts", "src/lib/realtime.ts", "src/lib/llm.ts", "src/lib/voiceModels.ts"]);
const SERVER_ONLY_MODEL_MODULE = "src/lib/voiceModels.ts";

const ROOT = process.cwd();
function sourceFiles(dir = join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css|json|svg)$/.test(e.name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

const hitsOf = (re: RegExp, files: string[]) =>
  files.flatMap((f) =>
    readFileSync(join(ROOT, f), "utf8")
      .split("\n")
      .flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])),
  );

describe("model id pattern", () => {
  it.each([
    "gpt-4", "gpt-4-turbo", "gpt-4-0613", "gpt-4.5-preview", "GPT-4", "gpt-3.5-turbo",
    "gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "gpt-4o-mini-transcribe",
    "gpt-realtime", "gpt-realtime-1.5", "gpt-realtime-mini", "GPT-4o", "o3", "o3-mini", "o4-mini", "whisper-1", "tts-1", "tts-1-hd",
    "gemini-2.5-flash", "gemini-pro", "eleven_turbo_v2_5", "eleven_multilingual_v2", "claude-sonnet-4-5", "claude-3-5-haiku",
  ])("catches %s", (id) => {
    expect(`Graded by ${id}.`).toMatch(MODEL_ID_RE);
    expect(`"${id}"`).toMatch(MODEL_ID_RE);
  });

  it.each(["OpenAI Realtime", "ElevenLabs voice agent", "AI model", "Your chat model", "LLM_MODEL", "REALTIME_MODEL", "Text · AI", "Coach: AI", "video", "photo3", "OpenAI", "GPT", "GPT style practice", "gpt-", "chatgpt-like"])(
    "leaves %s alone",
    (text) => expect(text).not.toMatch(MODEL_ID_RE),
  );
});

describe("no model ids in user-facing source", () => {
  const files = sourceFiles();

  it("scans a real tree", () => {
    expect(files).toContain("src/app/page.tsx");
    expect(files).toContain("src/app/api/llm/hints.ts");
    for (const f of BACKEND_ALLOWLIST) expect(files).toContain(f);
  });

  it("finds model ids only in the backend defaults (pages, components, API routes and errors included)", () => {
    expect(hitsOf(MODEL_ID_RE, files.filter((f) => !BACKEND_ALLOWLIST.has(f)))).toEqual([]);
  });

  it("keeps the voice tier model mapping server-only, imported only by server modules", () => {
    const src = readFileSync(join(ROOT, SERVER_ONLY_MODEL_MODULE), "utf8");
    expect(src.split("\n")[0]).toBe('import "server-only";');
    const importers = files.filter((f) => f !== SERVER_ONLY_MODEL_MODULE && /from ["'](?:@\/lib\/|\.\/|\.\.\/lib\/)voiceModels["']/.test(readFileSync(join(ROOT, f), "utf8")));
    // Each importer is itself server-only, so the ids can't reach a client bundle through it.
    expect(importers).toEqual(["src/lib/voiceTierServer.ts"]);
    for (const f of importers) expect(readFileSync(join(ROOT, f), "utf8").split("\n")[0]).toBe('import "server-only";');
    expect(hitsOf(/["']use client["']/, [SERVER_ONLY_MODEL_MODULE, ...importers])).toEqual([]);
  });

  it("touches the TrainerSession.realtimeModel column only where a verified receipt writes it", () => {
    // Code lines only: doc comments may name the column. Reading it anywhere else (a response, a page) needs a review.
    const code = (f: string) => readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");
    const users = files.filter((f) => /\brealtimeModel\b/.test(code(f)));
    expect(users).toEqual(["src/app/api/transcripts/route.ts"]);
  });

  it("no client code reads a model id from capabilities or a coach result", () => {
    expect(hitsOf(/capabilities\??\.(?:model|realtimeModel)\b|\.result\??\.model\b|\bcaps\??\.(?:model|realtimeModel)\b|\bsecret\??\.model\b/, files)).toEqual([]);
  });

  it("reads the configured model only where a provider request or the server-side audit log needs it", () => {
    const users = files.filter((f) => /\bllmModel\(\)/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(users.sort()).toEqual(["src/app/api/llm/check/route.ts", "src/app/api/transcripts/[id]/route.ts", "src/lib/llm.ts", "src/lib/serverConfig.ts"]);
  });
});

describe("landing page", () => {
  it("renders without model ids and keeps the provider names", () => {
    const html = renderToStaticMarkup(createElement(Home));
    expect(html.match(new RegExp(MODEL_ID_RE.source, "g")) ?? []).toEqual([]);
    // The provider names live in the OSS "What runs each job" section, which a branded tenant hides.
    if (!brand.showOssSections) return;
    expect(html).toContain("OpenAI Realtime");
    expect(html).toContain("ElevenLabs");
    expect(html).toContain("Your chat model");
  });
});

const ENV = {
  DEMO_MODE: "", DATABASE_URL: "", STRIPE_SECRET_KEY: "", VOICE_ENGINE: "", OPENAI_REALTIME_API_KEY: "",
  LLM_BASE_URL: "", LLM_API_KEY: "", OPENAI_API_KEY: "", ELEVENLABS_API_KEY: "", ELEVENLABS_AGENT_ID: "",
  LLM_MODEL: "", REALTIME_MODEL: "", REALTIME_MODEL_STANDARD: "", REALTIME_MODEL_PREMIUM: "", REALTIME_TRANSCRIBE_MODEL: "",
  REALTIME_VOICE: "", JWT_SECRET: "",
};
const stubEnv = (env: Partial<Record<keyof typeof ENV, string>>) => {
  for (const [k, v] of Object.entries({ ...ENV, ...env })) vi.stubEnv(k, v);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/config (unauthenticated JSON)", () => {
  const CONFIG_KEYS = ["billing", "database", "demoMode", "elevenlabs", "hosted", "llm", "provider", "realtime", "voiceEngines"];
  const read = async () => {
    const res = await configGET();
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  };

  it("reports booleans and provider names, never the chat or realtime model ids", async () => {
    stubEnv({
      LLM_API_KEY: "sk-llm-test", OPENAI_API_KEY: "sk-openai-test", LLM_MODEL: "gpt-4.1-mini",
      REALTIME_MODEL: "gpt-realtime-1.5", REALTIME_MODEL_STANDARD: "gpt-realtime-mini", REALTIME_MODEL_PREMIUM: "gpt-realtime-premium-test",
      REALTIME_TRANSCRIBE_MODEL: "gpt-4o-mini-transcribe",
      ELEVENLABS_API_KEY: "el-test", ELEVENLABS_AGENT_ID: "agent-test",
    });
    const { text, body } = await read();
    expect(Object.keys(body).sort()).toEqual(CONFIG_KEYS);
    expect(body).toMatchObject({ llm: true, realtime: true, elevenlabs: true, provider: "openai", voiceEngines: ["openai", "elevenlabs"] });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("realtimeModel");
    expect(text).not.toMatch(MODEL_ID_RE);
    expect(text).not.toMatch(/sk-llm-test|sk-openai-test|el-test|agent-test/);
  });

  it("does not leak a custom model name or a custom endpoint", async () => {
    stubEnv({ LLM_API_KEY: "k-test", LLM_BASE_URL: "https://llm.internal.example/v1", LLM_MODEL: "acme-private-chat-9", REALTIME_MODEL: "acme-voice-2" });
    const { text, body } = await read();
    expect(Object.keys(body).sort()).toEqual(CONFIG_KEYS);
    expect(body).toMatchObject({ llm: true, realtime: false, provider: "custom" });
    expect(text).not.toMatch(/acme-private-chat-9|acme-voice-2|internal\.example|k-test/);
  });

  it("stays model-free with no keys, when only the built-in defaults apply", async () => {
    stubEnv({});
    const { text, body } = await read();
    expect(Object.keys(body).sort()).toEqual(CONFIG_KEYS);
    expect(body).toMatchObject({ llm: false, realtime: false, elevenlabs: false, voiceEngines: [] });
    expect(text).not.toMatch(MODEL_ID_RE);
  });
});

describe("POST /api/realtime/session (response JSON)", () => {
  const SESSION_KEYS = ["clientSecret", "expiresAt", "receipt", "sessionId", "voice"];
  const mint = async () => {
    const fn = vi.fn(async () => Response.json({ value: "ek_nml_secret_1", expires_at: 1_900_000_000 }));
    vi.stubGlobal("fetch", fn);
    const res = await sessionPOST(new NextRequest("http://localhost/api/realtime/session", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.251" }, body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }),
    }));
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as Record<string, unknown>, sent: JSON.parse(String((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body)) };
  };

  it.each([
    ["built-in defaults", {}],
    ["every tier variable set", { REALTIME_MODEL: "gpt-realtime-1.5", REALTIME_MODEL_STANDARD: "acme-voice-std", REALTIME_MODEL_PREMIUM: "acme-voice-premium" }],
  ])("sends the model upstream and returns no model field or id, with %s", async (_label, env) => {
    stubEnv({ DEMO_MODE: "true", OPENAI_API_KEY: "sk-openai-test", JWT_SECRET: "test-only-not-a-secret-0123456789abcdef", ...env });
    const { res, text, body, sent } = await mint();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(SESSION_KEYS);
    expect(typeof sent.session.model).toBe("string");
    expect(text).not.toContain(sent.session.model);
    expect(text).not.toMatch(MODEL_ID_RE);
    expect(text).not.toMatch(/acme-voice|sk-openai-test/);
    // The receipt is opaque: decoding it shows no model either.
    const decoded = Buffer.from(String(body.receipt).replace(/^mr3\./, ""), "base64url").toString("latin1");
    expect(decoded).not.toContain(sent.session.model);
    expect(decoded).not.toMatch(MODEL_ID_RE);
  });
});

describe("POST /api/llm/check (response JSON and logs)", () => {
  const CHECK_KEYS = ["hint", "latencyMs", "ok", "status"];
  let n = 0;
  let warn: { mock: { calls: unknown[][] } };
  beforeEach(() => {
    // A fresh account and IP per check, so the route's limits never decide a test here.
    mocks.user = { id: `nml-${++n}`, email: `nml-${n}@example.test` };
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const check = async () => {
    const res = await checkPOST(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": `198.51.100.${n % 250}` } }));
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  /** Status, exact keys, and no model id anywhere in the body or the server log. */
  const expectNeutral = (r: Awaited<ReturnType<typeof check>>, model: string) => {
    expect(r.res.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(CHECK_KEYS);
    expect(r.text).not.toContain(model);
    expect(r.text).not.toMatch(MODEL_ID_RE);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(model);
    expect(logged).not.toMatch(MODEL_ID_RE);
  };
  const provider = (status: number, body: unknown) => {
    const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  // A model id from a known family, and a private name the pattern can't know about.
  const MODELS = ["gpt-4.1-mini", "acme-private-chat-9"];

  it.each(MODELS)("success with %s: the model goes upstream, the echoed model id does not come back", async (model) => {
    stubEnv({ LLM_API_KEY: "k-test", LLM_MODEL: model });
    const fn = provider(200, { id: "chatcmpl-1", model: `${model}-2025-04-14`, choices: [{ message: { content: "O" } }] });
    const r = await check();
    expectNeutral(r, model);
    expect(r.body).toMatchObject({ ok: true, status: 200, hint: "Connected. The key works and the configured model answered." });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe(model);
  });

  it.each(MODELS)("no key with %s: plain hint, no provider call", async (model) => {
    stubEnv({ LLM_MODEL: model });
    const fn = provider(200, {});
    const r = await check();
    expectNeutral(r, model);
    expect(r.body).toMatchObject({ ok: false, status: null, latencyMs: null });
    expect(String(r.body.hint)).toMatch(/LLM_API_KEY/);
    expect(fn).not.toHaveBeenCalled();
  });

  const HTTP: [number, RegExp][] = [
    [400, /refused the test call \(HTTP 400\).*LLM_MODEL/], [401, /rejected the API key/], [403, /permissions/],
    [404, /configured model.*LLM_MODEL/], [429, /quota/], [500, /server error \(HTTP 500\)/], [503, /server error \(HTTP 503\)/],
  ];
  for (const model of MODELS) {
    it.each(HTTP)(`provider HTTP %i with ${model}: the error body naming the model is never echoed`, async (status, hint) => {
      stubEnv({ LLM_API_KEY: "k-test", LLM_MODEL: model });
      provider(status, { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: "invalid_request_error", code: "model_not_found" } });
      const r = await check();
      expectNeutral(r, model);
      expect(r.body).toMatchObject({ ok: false, status });
      expect(String(r.body.hint)).toMatch(hint);
      expect(r.text).not.toMatch(/model_not_found|does not exist|invalid_request_error/);
    });
  }

  it.each(MODELS)("a 200 that isn't a chat completion, echoing %s, is flagged without the echo", async (model) => {
    stubEnv({ LLM_API_KEY: "k-test", LLM_MODEL: model });
    provider(200, { model, object: "error", message: `unknown model ${model}` });
    const r = await check();
    expectNeutral(r, model);
    expect(r.body).toMatchObject({ ok: false, status: 200 });
    expect(String(r.body.hint)).toMatch(/OpenAI-compatible chat API/);
  });

  it.each(MODELS)("network failure and timeout with %s: thrown messages naming the model stay out", async (model) => {
    stubEnv({ LLM_API_KEY: "k-test", LLM_MODEL: model });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(`fetch failed while calling ${model}`); }));
    const net = await check();
    expectNeutral(net, model);
    expect(String(net.body.hint)).toMatch(/couldn't reach the provider/);

    mocks.user = { id: `nml-${++n}`, email: `nml-${n}@example.test` };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException(`${model} timed out`, "TimeoutError"); }));
    const slow = await check();
    expectNeutral(slow, model);
    expect(String(slow.body.hint)).toMatch(/didn't answer within 15 seconds/);
  });
});

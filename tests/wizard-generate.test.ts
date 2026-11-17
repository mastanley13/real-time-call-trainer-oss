import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/persona/generate rejects oversized and malformed WizardInput on the
 * server before generatePersona runs. POST /api/persona/fetch-url does the same
 * for the URL field, so a huge or junk body never reaches fetchPublicPage.
 * The session check and the two generators are the only fakes.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "u-0", email: "rep@example.test" },
  generatePersona: vi.fn(),
  fetchPublicPage: vi.fn(),
}));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));
vi.mock("@/lib/personaWizard", () => ({ generatePersona: mocks.generatePersona }));
vi.mock("@/lib/safeFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safeFetch")>()),
  fetchPublicPage: mocks.fetchPublicPage,
}));

import { POST as generate } from "@/app/api/persona/generate/route";
import { POST as fetchUrl } from "@/app/api/persona/fetch-url/route";
import { MAX_BODY_BYTES, USER_LIMITS } from "@/lib/rateLimit";
import type { WizardInput } from "@/lib/wizard-types";

const STUB = { scenario: { id: "custom-test-aaaa", title: "Test draft" }, sources: {}, method: "template" as const };

const valid = (): WizardInput => ({
  role: "sdr",
  industry: "Freight brokerage",
  callType: "cold",
  difficulty: "medium",
  product: "Load matching for mid-size brokerages.",
  contexts: [{ kind: "icp", text: "VP of Operations at a 50-300 person brokerage." }],
});

let users = 0;
let ips = 0;
const signIn = () => (mocks.user = { id: `wiz-${++users}`, email: `wiz-${users}@example.test` });
const ip = () => `198.18.71.${(++ips % 250) + 1}`;

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": extra["x-forwarded-for"] ?? ip(),
    ...extra,
  };
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  signIn();
  mocks.generatePersona.mockReset();
  mocks.generatePersona.mockResolvedValue(STUB);
  mocks.fetchPublicPage.mockReset();
  mocks.fetchPublicPage.mockResolvedValue({ url: "https://example.test/product", title: "Example", text: "Hello", bytes: 5 });
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_WIZARD_MAX", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/persona/generate input bounds", () => {
  it("accepts a valid body and returns the generator result, with no model id", async () => {
    const input = valid();
    const res = await generate(post("/api/persona/generate", input));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STUB);
    expect(mocks.generatePersona).toHaveBeenCalledOnce();
    expect(mocks.generatePersona.mock.calls[0][0]).toEqual(input);
  });

  it("accepts fields at their max length and five contexts", async () => {
    const input: WizardInput = {
      role: "r".repeat(40),
      industry: "i".repeat(80),
      callType: "cold",
      difficulty: "hard",
      product: "p".repeat(400),
      contexts: Array.from({ length: 5 }, (_, i) => ({
        kind: "job" as const,
        text: "t".repeat(8000),
        label: i === 0 ? "l".repeat(200) : undefined,
      })),
    };
    const res = await generate(post("/api/persona/generate", input));
    expect(res.status).toBe(200);
    expect(mocks.generatePersona).toHaveBeenCalledOnce();
  });

  it("rejects oversized role, industry, product, context text and label without generating", async () => {
    const base = valid();
    const cases: WizardInput[] = [
      { ...base, role: "r".repeat(41) },
      { ...base, industry: "i".repeat(81) },
      { ...base, product: "p".repeat(401) },
      { ...base, contexts: [{ kind: "crm", text: "t".repeat(8001) }] },
      { ...base, contexts: [{ kind: "icp", text: "ok", label: "l".repeat(201) }] },
    ];
    for (const body of cases) {
      mocks.generatePersona.mockClear();
      const res = await generate(post("/api/persona/generate", body));
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "Invalid request body" });
      expect(mocks.generatePersona).not.toHaveBeenCalled();
    }
  });

  it("rejects a sixth context and a context whose kind is not on the list", async () => {
    const six = { ...valid(), contexts: Array.from({ length: 6 }, () => ({ kind: "job" as const, text: "x" })) };
    const badKind = { ...valid(), contexts: [{ kind: "website", text: "https://example.test" }] };
    for (const body of [six, badKind]) {
      mocks.generatePersona.mockClear();
      const res = await generate(post("/api/persona/generate", body));
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string; details?: string[] };
      expect(json.error).toBe("Invalid request body");
      expect(json.details?.some((d) => d.includes("contexts"))).toBe(true);
      expect(mocks.generatePersona).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing role, an empty role, a bad call type and a bad difficulty", async () => {
    const { role: _omit, ...noRole } = valid();
    const cases = [
      noRole,
      { ...valid(), role: "" },
      { ...valid(), callType: "cold-call" },
      { ...valid(), difficulty: "brutal" },
      { ...valid(), contexts: "not-an-array" },
      { role: 12, callType: "cold", difficulty: "easy", product: "", contexts: [] },
    ];
    for (const body of cases) {
      mocks.generatePersona.mockClear();
      const res = await generate(post("/api/persona/generate", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("Invalid request body");
      expect(mocks.generatePersona).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid JSON and a payload that declares it is over the body cap", async () => {
    const junk = await generate(post("/api/persona/generate", "{", { "content-type": "application/json" }));
    expect(junk.status).toBe(400);
    expect(await junk.json()).toEqual({ error: "Invalid request body" });

    const huge = await generate(post("/api/persona/generate", "{}", { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({ error: "Invalid request body" });
    expect(mocks.generatePersona).not.toHaveBeenCalled();
  });
});

describe("POST /api/persona/fetch-url input bounds", () => {
  it("accepts a trimmed public URL and calls fetchPublicPage with it", async () => {
    const res = await fetchUrl(post("/api/persona/fetch-url", { url: "  https://example.test/product  " }));
    expect(res.status).toBe(200);
    expect(mocks.fetchPublicPage).toHaveBeenCalledWith("https://example.test/product");
  });

  it("rejects a missing, empty, non-string or overlong URL without fetching", async () => {
    const cases: unknown[] = [{}, { url: "" }, { url: "   " }, { url: 12 }, { url: `https://example.test/${"a".repeat(2048)}` }];
    for (const body of cases) {
      mocks.fetchPublicPage.mockClear();
      const res = await fetchUrl(post("/api/persona/fetch-url", body));
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request", message: "Please enter a web address." });
      expect(mocks.fetchPublicPage).not.toHaveBeenCalled();
    }
  });
});

describe("wizard generate rate limits", () => {
  it("limits one account across many IPs, and never generates the extra call", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= USER_LIMITS.wizard.limit; i++) {
      codes.push((await generate(post("/api/persona/generate", valid(), { "x-forwarded-for": `198.18.72.${i + 1}` }))).status);
    }
    expect(codes.slice(0, -1).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect(mocks.generatePersona).toHaveBeenCalledTimes(USER_LIMITS.wizard.limit);
  });

  it("a second account on a new IP is still allowed after the first is capped", async () => {
    vi.stubEnv("RATE_LIMIT_WIZARD_MAX", "2");
    const from = "198.18.73.9";
    expect((await generate(post("/api/persona/generate", valid(), { "x-forwarded-for": from }))).status).toBe(200);
    expect((await generate(post("/api/persona/generate", valid(), { "x-forwarded-for": from }))).status).toBe(200);
    const limited = await generate(post("/api/persona/generate", valid(), { "x-forwarded-for": from }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await limited.json()).error).toBe("rate_limited");
    expect(mocks.generatePersona).toHaveBeenCalledTimes(2);

    signIn();
    const other = await generate(post("/api/persona/generate", valid(), { "x-forwarded-for": "198.18.73.10" }));
    expect(other.status).toBe(200);
    expect(mocks.generatePersona).toHaveBeenCalledTimes(3);
  });
});

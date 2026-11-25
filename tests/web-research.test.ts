import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchPageError } from "@/lib/safeFetch";
import type { FetchedPage } from "@/lib/wizard-types";
import {
  extractResponsesText,
  fetchAndResearchPublicPage,
  mergeFetchedAndResearch,
  needsWebEnrichment,
  researchWithOpenAiWebSearch,
  scrapeWithFirecrawl,
} from "@/lib/webResearch";

const CLEAR = [
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_BACKUP_1",
  "OPENAI_API_KEY_BACKUP_2",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "WIZARD_API_KEY",
  "WIZARD_PROVIDER",
  "WEB_RESEARCH_MODEL",
  "FIRECRAWL_API_KEY",
];

function stubEnv(env: Record<string, string> = {}) {
  for (const k of CLEAR) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

beforeEach(() => {
  stubEnv();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const richPage = (overrides: Partial<FetchedPage> = {}): FetchedPage => ({
  url: "https://acme.example/pricing",
  title: "Acme Pricing",
  description: "Automated dispatch for field teams.",
  suggestedIndustry: "Home services",
  suggestedProduct: "Acme Dispatch automates technician scheduling starting at $199/mo.",
  text: "Acme Dispatch starts at $199/mo per office. ".repeat(30),
  bytes: 1500,
  source: "direct",
  ...overrides,
});

describe("needsWebEnrichment", () => {
  it("triggers on null, thin JS-only pages, and bare homepages missing pricing signals", () => {
    expect(needsWebEnrichment(new URL("https://acme.example/"), null)).toBe(true);
    expect(needsWebEnrichment(new URL("https://acme.example/pricing"), richPage({ text: "Loading..." }))).toBe(true);
    expect(
      needsWebEnrichment(
        new URL("https://acme.example/"),
        richPage({ url: "https://acme.example/", text: "We build modern software for operations teams. ".repeat(25) }),
      ),
    ).toBe(true);
  });

  it("skips extra web search when direct HTML already gave rich subpage or priced homepage content", () => {
    expect(needsWebEnrichment(new URL("https://acme.example/pricing"), richPage())).toBe(false);
    expect(needsWebEnrichment(new URL("https://acme.example/"), richPage({ url: "https://acme.example/" }))).toBe(false);
  });
});

describe("extractResponsesText and mergeFetchedAndResearch", () => {
  it("extracts text from both output_text and nested output message blocks", () => {
    expect(extractResponsesText({ output_text: '{"ok":true}' })).toBe('{"ok":true}');
    expect(
      extractResponsesText({
        output: [
          { type: "web_search_call", id: "ws_1" },
          { type: "message", content: [{ type: "output_text", text: '{"title":"Acme"}' }] },
        ],
      }),
    ).toBe('{"title":"Acme"}');
  });

  it("merges direct HTML and web research within the 8,000-char cap", () => {
    const direct = richPage({ url: "https://acme.example/", title: "acme.example", text: "D".repeat(6000) });
    const researched: FetchedPage = {
      url: "https://acme.example/",
      title: "Acme Robotics",
      description: "Warehouse automation robots.",
      suggestedIndustry: "Logistics",
      suggestedProduct: "Acme Robotics leases warehouse pickers at $3,500/mo.",
      text: "R".repeat(4000),
      bytes: 4000,
      source: "web_search",
    };
    const merged = mergeFetchedAndResearch(direct, researched);
    expect(merged.source).toBe("direct+web_search");
    expect(merged.title).toBe("Acme Robotics");
    expect(merged.suggestedProduct).toBe(researched.suggestedProduct);
    expect(merged.text).toContain("[Web Research]");
    expect(merged.text.length).toBeLessThanOrEqual(8000);
  });
});

describe("researchWithOpenAiWebSearch", () => {
  it("calls OpenAI Responses API with tools:[{type:'web_search'}] and strict json_schema", async () => {
    stubEnv({ OPENAI_API_KEY: "sk-openai-test" });
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        const headers = init.headers as Record<string, string>;
        calls.push({ url: String(url), body, auth: headers.Authorization });
        return Response.json({
          output: [
            { type: "web_search_call", id: "ws_1" },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    title: "Northstar Roofing",
                    description: "Residential and commercial roof replacement across Texas.",
                    suggestedIndustry: "Home services",
                    suggestedProduct: "Free roof inspection and turnkey replacement with financing options.",
                    summaryText: "Offer: Roof repair and replacement. Target buyer: Homeowners after storm damage.",
                  }),
                },
              ],
            },
          ],
        });
      }),
    );

    const out = await researchWithOpenAiWebSearch(new URL("https://northstarroofing.example/"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].auth).toBe("Bearer sk-openai-test");
    expect(calls[0].body.tools).toEqual([{ type: "web_search" }]);
    expect((calls[0].body.text as { format: { type: string; strict: boolean } }).format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
    expect(out).toMatchObject({
      title: "Northstar Roofing",
      suggestedIndustry: "Home services",
      source: "web_search",
    });
  });

  it("never sends a custom non-OpenAI LLM_API_KEY to api.openai.com", async () => {
    stubEnv({ LLM_API_KEY: "custom-key", LLM_BASE_URL: "https://llm.internal.example/v1" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await researchWithOpenAiWebSearch(new URL("https://acme.example/"))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("scrapeWithFirecrawl", () => {
  it("skips when FIRECRAWL_API_KEY is unset and calls /v1/scrape when set", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          markdown: "# Acme Platform\n\nStarts at $99/mo for small teams.",
          metadata: { title: "Acme Platform", description: "Workflow automation for sales teams." },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(await scrapeWithFirecrawl(new URL("https://acme.example/"))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    stubEnv({ FIRECRAWL_API_KEY: "fc-test-key" });
    const out = await scrapeWithFirecrawl(new URL("https://acme.example/"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      title: "Acme Platform",
      source: "firecrawl",
    });
    expect(out?.text).toContain("$99/mo");
  });
});

describe("fetchAndResearchPublicPage SSRF guard", () => {
  it("blocks private/loopback addresses before calling Firecrawl or OpenAI", async () => {
    stubEnv({ OPENAI_API_KEY: "sk-openai-test", FIRECRAWL_API_KEY: "fc-test-key" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchAndResearchPublicPage("http://127.0.0.1/admin")).rejects.toBeInstanceOf(FetchPageError);
    await expect(fetchAndResearchPublicPage("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(FetchPageError);
    await expect(fetchAndResearchPublicPage("http://localhost:3000")).rejects.toBeInstanceOf(FetchPageError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import "server-only";
import { z } from "zod";
import { OPENAI_DEFAULT_BASE_URL, isOpenAiBaseUrl } from "./openaiHost";
import { chatKeyPlan, classifyOpenAiResponse, withOpenAiKeyFailover } from "./openaiKeys";
import { FetchPageError, fetchPublicPage, validatePublicUrl } from "./safeFetch";
import { firecrawlKey, llmBaseUrl, webResearchModel, wizardOpenAiKey } from "./serverConfig";
import type { FetchedPage } from "./wizard-types";

/**
 * Multi-tier public website reader for the Persona Wizard (/api/persona/fetch-url).
 *
 * 1. SSRF gate first (validatePublicUrl in safeFetch.ts): private IPs, loopback,
 *    metadata hosts, non-standard ports and internal hostnames are always blocked
 *    before any outbound reader or web-search call is made.
 * 2. Direct SSRF-safe HTML GET (fetchPublicPage): fast and free for static pages.
 * 3. Optional Firecrawl (/v1/scrape) when FIRECRAWL_API_KEY is set and direct HTML
 *    is blocked or thin (JS-only SPAs).
 * 4. OpenAI Responses API with built-in web_search tool (POST /v1/responses) using
 *    the existing OpenAI key (with quota failover), rescuing blocked/JS-only pages
 *    and enriching bare homepages with pricing, product details, and buyer pains.
 *
 * Logs carry status codes and slot numbers only: never keys, prompts, model ids, or raw bodies.
 */

const OPENAI_RESPONSES_URL = `${OPENAI_DEFAULT_BASE_URL}/responses`;
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const MAX_TEXT_CHARS = 8_000;
const THIN_PAGE_CHARS = 500;
const OPENAI_RESEARCH_TIMEOUT_MS = 25_000;
const FIRECRAWL_TIMEOUT_MS = 15_000;

const PRICING_OR_DETAIL_RE = /\$\d|pricing|per month|\/mo\b|\/yr\b|free trial|FAQ:/i;

/** True when a direct HTML fetch failed, returned thin JS-only text, or fetched a homepage without pricing/detail signals. */
export function needsWebEnrichment(url: URL, page: FetchedPage | null): boolean {
  if (!page) return true;
  const len = page.text.trim().length;
  if (len < THIN_PAGE_CHARS) return true;
  const isHomepage = url.pathname === "" || url.pathname === "/";
  if (isHomepage && !PRICING_OR_DETAIL_RE.test(page.text)) return true;
  return false;
}

const ResearchResultSchema = z.object({
  title: z.string().default(""),
  description: z.string().default(""),
  suggestedIndustry: z.string().default(""),
  suggestedProduct: z.string().default(""),
  summaryText: z.string().default(""),
});

const WEBSITE_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "suggestedIndustry", "suggestedProduct", "summaryText"],
  properties: {
    title: { type: "string", description: "Company or product name and short page title (<= 120 chars)." },
    description: { type: "string", description: "1-2 sentence overview of what the company sells (<= 300 chars)." },
    suggestedIndustry: { type: "string", description: "Concise industry or vertical label, e.g. 'Home services', 'Logistics SaaS', 'Auto sales' (<= 80 chars)." },
    suggestedProduct: { type: "string", description: "Clear 1-2 sentence pitch of the core product/service and public pricing if found (<= 300 chars)." },
    summaryText: {
      type: "string",
      description:
        "Structured factual briefing for a sales roleplay builder covering: Offer & key features, Public pricing/plans (if found), Target buyer / ICP, Differentiators, and Common buyer questions or objections. Plain text, <= 4500 chars.",
    },
  },
} as const;

function capText(text: string, max = MAX_TEXT_CHARS): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.8 ? cut.slice(0, sp) : cut).trim();
}

/** Merges direct HTML extraction with live web research into one bounded FetchedPage. */
export function mergeFetchedAndResearch(direct: FetchedPage | null, researched: FetchedPage): FetchedPage {
  if (!direct) return researched;
  const combinedText = capText(`[Web Research]\n${researched.text}\n\n[Direct Page]\n${direct.text}`);
  return {
    url: direct.url || researched.url,
    title: (direct.title && direct.title !== new URL(direct.url).hostname ? direct.title : researched.title) || direct.title || researched.title,
    description: direct.description || researched.description,
    suggestedIndustry: direct.suggestedIndustry || researched.suggestedIndustry,
    suggestedProduct: researched.suggestedProduct || direct.suggestedProduct,
    text: combinedText,
    bytes: Math.max(direct.bytes, researched.bytes),
    source: "direct+web_search",
  };
}

/** Extracts text output from an OpenAI Responses API JSON payload. */
export function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as { output_text?: unknown; output?: unknown };
  if (typeof root.output_text === "string" && root.output_text.trim()) return root.output_text.trim();
  if (!Array.isArray(root.output)) return "";
  const parts: string[] = [];
  for (const item of root.output) {
    if (!item || typeof item !== "object") continue;
    const msg = item as { type?: unknown; content?: unknown };
    if (msg.type !== "message" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; text?: unknown };
      if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n").trim();
}

/** Optional Firecrawl headless scraper. Runs only when FIRECRAWL_API_KEY is configured. */
export async function scrapeWithFirecrawl(url: URL): Promise<FetchedPage | null> {
  const key = firecrawlKey();
  if (!key) return null;
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        url: url.toString(),
        formats: ["markdown"],
        onlyMainContent: true,
      }),
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      console.warn("[webResearch] firecrawl status", { status: res.status });
      return null;
    }
    const raw = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: unknown; metadata?: { title?: unknown; description?: unknown; sourceURL?: unknown } };
    };
    const md = typeof raw?.data?.markdown === "string" ? raw.data.markdown.trim() : "";
    if (!md) return null;
    const title = typeof raw?.data?.metadata?.title === "string" ? raw.data.metadata.title.trim().slice(0, 200) : url.hostname;
    const description = typeof raw?.data?.metadata?.description === "string" ? raw.data.metadata.description.trim().slice(0, 400) : undefined;
    const text = capText(md);
    return {
      url: url.toString(),
      title: title || url.hostname,
      ...(description ? { description } : {}),
      ...(description ? { suggestedProduct: description.slice(0, 300) } : {}),
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      source: "firecrawl",
    };
  } catch {
    console.warn("[webResearch] firecrawl failed");
    return null;
  }
}

/**
 * Researches a validated public URL using OpenAI's Responses API with the built-in
 * web_search tool. Never sends an OpenAI key to a custom LLM_BASE_URL.
 */
export async function researchWithOpenAiWebSearch(url: URL, directPage?: FetchedPage | null): Promise<FetchedPage | null> {
  const dedicated = wizardOpenAiKey();
  const plan = dedicated ? ({ kind: "single", key: dedicated } as const) : chatKeyPlan(process.env);
  if (plan.kind === "none") return null;
  // Never send a custom non-OpenAI LLM_API_KEY to api.openai.com.
  if (!dedicated && plan.kind === "single" && !isOpenAiBaseUrl(llmBaseUrl())) return null;

  const model = webResearchModel();
  const host = url.hostname;
  const userPrompt = [
    `Research the public company website: ${url.toString()} (domain: ${host}).`,
    "Use web search to find accurate, current details from this site and its key pages (homepage, product/services, pricing, about, FAQ).",
    "Extract: what they sell, who buys it (target buyer title and company type), public pricing or engagement model if listed, key value propositions, and realistic objections a buyer would raise on a sales call.",
    "Stay strictly factual to what you find; if pricing is not public, say pricing is not listed rather than inventing numbers.",
    directPage?.text
      ? `\nPartial direct HTML already extracted from ${directPage.url}:\n${directPage.text.slice(0, 1500)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: "You are a concise B2B/B2C sales research analyst. Gather factual company, offer, pricing, and buyer context from public web pages.",
      },
      { role: "user", content: userPrompt },
    ],
    tools: [{ type: "web_search" }],
    max_output_tokens: 2000,
    text: {
      format: {
        type: "json_schema",
        name: "website_research",
        strict: true,
        schema: WEBSITE_RESEARCH_SCHEMA,
      },
    },
  };

  const runWithKey = async (apiKey: string) => {
    const res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OPENAI_RESEARCH_TIMEOUT_MS),
      redirect: "error",
    });
    if (res.ok) return { outcome: "ok" as const, value: res };
    const outcome = await classifyOpenAiResponse(OPENAI_RESPONSES_URL, res);
    void res.body?.cancel().catch(() => {});
    return { outcome, status: res.status, value: res };
  };

  try {
    let res: Response | null = null;
    if (plan.kind === "ladder") {
      const result = await withOpenAiKeyFailover("chat", (key) => runWithKey(key));
      if (result.kind === "ok") {
        res = result.value;
      } else {
        console.warn("[webResearch] openai responses status", { status: result.status });
        return null;
      }
    } else {
      const attempt = await runWithKey(plan.key);
      if (attempt.outcome === "ok") {
        res = attempt.value;
      } else {
        console.warn("[webResearch] openai responses status", { status: attempt.status });
        return null;
      }
    }

    const json = await res.json();
    const rawText = extractResponsesText(json);
    if (!rawText) return null;
    const parsed = ResearchResultSchema.safeParse(JSON.parse(rawText));
    if (!parsed.success) return null;
    const d = parsed.data;
    const bodyText = capText(d.summaryText || d.description);
    if (!bodyText) return null;

    return {
      url: url.toString(),
      title: d.title.trim().slice(0, 200) || host,
      ...(d.description.trim() ? { description: d.description.trim().slice(0, 400) } : {}),
      ...(d.suggestedIndustry.trim() ? { suggestedIndustry: d.suggestedIndustry.trim().slice(0, 80) } : {}),
      ...(d.suggestedProduct.trim() ? { suggestedProduct: d.suggestedProduct.trim().slice(0, 300) } : {}),
      text: bodyText,
      bytes: Buffer.byteLength(bodyText, "utf8"),
      source: "web_search",
    };
  } catch {
    console.warn("[webResearch] openai web_search failed");
    return null;
  }
}

/**
 * Fetches a public URL through the SSRF gate, then rescues blocked/thin pages or enriches
 * bare homepages via optional Firecrawl and OpenAI's built-in web_search tool.
 */
export async function fetchAndResearchPublicPage(rawUrl: string): Promise<FetchedPage> {
  // Always validate scheme, port, hostname, and public DNS resolution FIRST.
  const validatedUrl = await validatePublicUrl(rawUrl);

  let directPage: FetchedPage | null = null;
  let directError: unknown = null;
  try {
    directPage = { ...(await fetchPublicPage(rawUrl)), source: "direct" };
  } catch (e) {
    directError = e;
  }

  if (directPage && !needsWebEnrichment(validatedUrl, directPage)) {
    return directPage;
  }

  let bestPage: FetchedPage | null = directPage;

  // Optional headless rendering via Firecrawl when direct HTML was blocked or thin.
  if (!bestPage || bestPage.text.trim().length < THIN_PAGE_CHARS) {
    const fc = await scrapeWithFirecrawl(validatedUrl);
    if (fc && fc.text.trim().length >= THIN_PAGE_CHARS) {
      bestPage = fc;
      if (!needsWebEnrichment(validatedUrl, bestPage)) return bestPage;
    }
  }

  // OpenAI Responses API web_search tool (zero extra vendors; uses existing OpenAI key).
  const researched = await researchWithOpenAiWebSearch(validatedUrl, bestPage);
  if (researched) {
    return mergeFetchedAndResearch(bestPage, researched);
  }

  if (bestPage) return bestPage;
  if (directError instanceof FetchPageError) throw directError;
  throw new FetchPageError("We couldn't read that website. Check the address or paste the text instead.");
}

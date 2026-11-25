import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Website extraction for the persona wizard: meta description, Open Graph, JSON-LD (product, price, category, FAQ),
 * the [Page Summary] header, and <main>/<article> preferred over nav and footer boilerplate. No network: DNS and the
 * http(s) request are mocked the same way as tests/safefetch.test.ts, and the URL guard is not changed by any of this.
 */

const { lookup, serve } = vi.hoisted(() => ({
  lookup: vi.fn(),
  serve: vi.fn<(url: string) => Promise<Response>>(),
}));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const promises = { ...actual.promises, lookup };
  return { ...actual, promises, default: { ...actual, promises } };
});
/** Resolves through the lookup hook it was given (so the pinned lookup still runs), then plays the server. */
function fakeRequest(url: URL, opts: { lookup?: LookupFunction }, onResponse: (res: IncomingMessage) => void) {
  const req = Object.assign(new EventEmitter(), {
    destroy: (e?: Error) => { if (e) req.emit("error", e); },
    end: () => {
      if (!opts.lookup) return req.emit("error", new Error("no lookup hook"));
      opts.lookup(url.hostname, { all: true }, (err) => {
        if (err) return req.emit("error", err);
        serve(url.toString())
          .then(async (r) => {
            const bytes = Buffer.from(await r.arrayBuffer());
            onResponse(Object.assign(Readable.from(bytes.length ? [bytes] : []), { statusCode: r.status, headers: Object.fromEntries(r.headers) }) as unknown as IncomingMessage);
          })
          .catch((e: Error) => req.emit("error", e));
      });
    },
  });
  return req;
}
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return { ...actual, request: fakeRequest, default: { ...actual, request: fakeRequest } };
});
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: fakeRequest, default: { ...actual, request: fakeRequest } };
});

import { extractPageMeta, fetchPublicPage, htmlToText } from "@/lib/safeFetch";

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const para = (word: string, n: number) => `<p>${Array.from({ length: n }, (_, i) => `${word} sentence number ${i} about load matching.`).join(" ")}</p>`;

const PRODUCT_PAGE = `<!doctype html><html><head>
<title>Ridgeline Load Match | Ridgeline</title>
<meta name="description" content="Match loads to vetted carriers in seconds. Cut empty miles and flag risky carriers before you book. Built for mid-size brokerages.">
<meta property="og:title" content="Ridgeline Load Match">
<meta property='og:site_name' content='Ridgeline'>
<meta property="og:description" content="OG text that should lose to the meta description">
${ld({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Ridgeline Freight Tech" },
    { "@type": "SoftwareApplication", name: "Ridgeline Load Match", applicationCategory: "Logistics software", offers: { "@type": "Offer", price: "1200", priceCurrency: "USD" } },
  ],
})}
${ld({
  "@type": "FAQPage",
  mainEntity: [
    { "@type": "Question", name: "Does it work with my TMS?", acceptedAnswer: { "@type": "Answer", text: "Yes, it connects to the common TMS platforms." } },
    { "@type": "Question", name: "Is there a contract?", acceptedAnswer: { "@type": "Answer", text: "Month to month, cancel any time." } },
  ],
})}
<script type="application/ld+json">{ not json </script>
</head><body>
<nav><a>Home</a><a>Pricing</a><a>Login</a></nav>
<main><h1>Load matching that pays for itself</h1>${para("Main", 12)}<nav>In-page nav</nav></main>
<footer>Copyright Ridgeline. Privacy. Terms.</footer>
</body></html>`;

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  serve.mockReset();
});

describe("extractPageMeta", () => {
  it("reads meta, Open Graph and JSON-LD (graph, product, offer price, category, FAQ)", () => {
    const m = extractPageMeta(PRODUCT_PAGE);
    expect(m.description).toBe("Match loads to vetted carriers in seconds. Cut empty miles and flag risky carriers before you book. Built for mid-size brokerages.");
    expect(m.ogTitle).toBe("Ridgeline Load Match");
    expect(m.siteName).toBe("Ridgeline");
    expect(m.productName).toBe("Ridgeline Load Match");
    expect(m.price).toBe("$1200");
    expect(m.category).toBe("Logistics software");
    expect(m.faqs).toEqual([
      { q: "Does it work with my TMS?", a: "Yes, it connects to the common TMS platforms." },
      { q: "Is there a contract?", a: "Month to month, cancel any time." },
    ]);
  });

  it("falls back to og:description, decodes entities and strips markup", () => {
    const m = extractPageMeta(`<meta content="Fast &amp; fair &lt;b&gt;quotes&lt;/b&gt;" property="og:description"><meta name="twitter:title" content="Quote Desk">`);
    expect(m.description).toBe("Fast & fair quotes");
    expect(m.ogTitle).toBe("Quote Desk");
  });

  it("uses a JSON-LD description and a non-USD price when the page has no meta description", () => {
    const m = extractPageMeta(ld({ "@type": "Product", name: "Solar Kit", description: "Rooftop solar kit.", offers: [{ price: 7999, priceCurrency: "eur" }] }));
    expect(m).toMatchObject({ productName: "Solar Kit", description: "Rooftop solar kit.", price: "7999 EUR" });
  });

  it("ignores malformed JSON-LD and non-JSON-LD scripts", () => {
    const m = extractPageMeta(`<script>var x = {"@type":"Product","name":"Nope"};</script><script type="application/ld+json">{oops</script>`);
    expect(m).toEqual({ faqs: [] });
  });

  it("only scans the first 128 KB", () => {
    const m = extractPageMeta(`${" ".repeat(140_000)}<meta name="description" content="Too late">`);
    expect(m.description).toBeUndefined();
  });

  it.each([
    ["unclosed <meta", "<meta".repeat(200_000)],
    ["unclosed attribute quotes", `<meta name="description" content="${"x".repeat(1_000_000)}`],
    ["unclosed ld+json scripts", '<script type="application/ld+json">{"a":'.repeat(30_000)],
    ["many tiny JSON-LD blocks", ld({ "@type": "Product", name: "x" }).repeat(20_000)],
    ["deeply nested JSON-LD", `<script type="application/ld+json">${"[".repeat(5_000)}${"]".repeat(5_000)}</script>`],
    ["huge JSON-LD fan-out", ld(Array.from({ length: 5_000 }, () => ({ "@type": "Thing", a: { b: { c: [1, 2, 3] } } })))],
  ])("handles %s in linear time", (_label, payload) => {
    const t0 = performance.now();
    extractPageMeta(payload);
    htmlToText(payload);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("htmlToText with metadata and main content", () => {
  it("prepends a [Page Summary] and keeps <main> without nav and footer", () => {
    const page = htmlToText(PRODUCT_PAGE);
    expect(page.title).toBe("Ridgeline Load Match | Ridgeline");
    const [summary, body] = page.text.split("\n[Page Text]\n");
    expect(summary.split("\n")).toEqual([
      "[Page Summary]",
      "Site: Ridgeline",
      "Page: Ridgeline Load Match",
      "About: Match loads to vetted carriers in seconds. Cut empty miles and flag risky carriers before you book. Built for mid-size brokerages.",
      "Product: Ridgeline Load Match, priced at $1200 (Logistics software)",
      "FAQ: Does it work with my TMS? Yes, it connects to the common TMS platforms.",
      "FAQ: Is there a contract? Month to month, cancel any time.",
    ]);
    expect(body.startsWith("Load matching that pays for itself\nMain sentence number 0")).toBe(true);
    expect(body).not.toMatch(/Home|Pricing|Login|Copyright|In-page nav/);
    expect(page.text).not.toMatch(/not json|@type|schema\.org/);
    expect(page.description).toMatch(/^Match loads to vetted carriers/);
    expect(page.suggestedIndustry).toBe("Logistics software");
    expect(page.suggestedProduct).toBe("Ridgeline Load Match: Match loads to vetted carriers in seconds. Cut empty miles and flag risky carriers before you book.");
  });

  it("keeps nav and footer when the main content is too thin to stand alone", () => {
    const page = htmlToText(`<nav>Home</nav><main><p>Short pitch.</p></main><footer>Call 555-0100</footer>`);
    expect(page).toEqual({ title: "", text: "Home\nShort pitch.\nCall 555-0100" });
  });

  it("drops nav and footer on a page without <main> only when enough text remains", () => {
    const long = htmlToText(`<nav>Menu links</nav><div>${para("Body", 12)}</div><footer>Legal footer</footer>`);
    expect(long.text).not.toMatch(/Menu links|Legal footer/);
    expect(long.text).toMatch(/^Body sentence number 0/);
    const short = htmlToText(`<nav>Menu links</nav><div><p>Tiny site.</p></div><footer>Legal footer</footer>`);
    expect(short.text).toBe("Menu links\nTiny site.\nLegal footer");
  });

  it("uses <article> when there is no <main>", () => {
    const page = htmlToText(`<header>Site header</header><nav>Nav</nav><article>${para("Article", 12)}</article><aside>Related posts</aside>`);
    expect(page.text).toMatch(/^Article sentence number 0/);
    expect(page.text).not.toMatch(/Site header|Related posts|Nav/);
  });

  it("stays within 8,000 characters with the summary first", () => {
    const page = htmlToText(PRODUCT_PAGE.replace(para("Main", 12), para("Main", 600)));
    expect(page.text.length).toBeLessThanOrEqual(8000);
    expect(page.text.startsWith("[Page Summary]\n")).toBe(true);
  });

  it("caps the suggested pitch at 300 characters on a word boundary", () => {
    const long = `${"Freight ".repeat(80)}matching`;
    const page = htmlToText(`<title>Load Desk</title><meta name="description" content="${long}"><p>Body.</p>`);
    expect(page.suggestedProduct!.length).toBeLessThanOrEqual(300);
    expect(page.suggestedProduct!.startsWith("Load Desk: Freight Freight")).toBe(true);
    expect(page.suggestedProduct!.endsWith("…")).toBe(true);
  });

  it("adds no summary or extra fields for a page without metadata", () => {
    expect(htmlToText("<html><head><title>Plain</title></head><body><p>Hello.</p></body></html>")).toEqual({ title: "Plain", text: "Hello." });
  });
});

describe("fetchPublicPage carries the extracted metadata", () => {
  it("returns description, suggestedProduct and suggestedIndustry with the summarized text", async () => {
    serve.mockResolvedValue(html(PRODUCT_PAGE));
    const page = await fetchPublicPage("https://ridgeline.example/load-match");
    expect(lookup).toHaveBeenCalledWith("ridgeline.example", expect.objectContaining({ all: true }));
    expect(page).toMatchObject({
      url: "https://ridgeline.example/load-match",
      title: "Ridgeline Load Match | Ridgeline",
      description: expect.stringMatching(/^Match loads to vetted carriers/),
      suggestedIndustry: "Logistics software",
      suggestedProduct: expect.stringMatching(/^Ridgeline Load Match: /),
    });
    expect(page.text.startsWith("[Page Summary]\n")).toBe(true);
    expect(page.bytes).toBeGreaterThan(0);
  });

  it("leaves the optional fields out for plain text and for pages without metadata", async () => {
    serve.mockResolvedValue(new Response("Just text.", { status: 200, headers: { "content-type": "text/plain" } }));
    const text = await fetchPublicPage("https://ridgeline.example/notes.txt");
    expect(Object.keys(text).sort()).toEqual(["bytes", "text", "title", "url"]);
    serve.mockResolvedValue(html("<title>Bare</title><p>Hi.</p>"));
    const bare = await fetchPublicPage("https://ridgeline.example/");
    expect(Object.keys(bare).sort()).toEqual(["bytes", "text", "title", "url"]);
  });

  it("still refuses a private address before any request", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    await expect(fetchPublicPage("https://ridgeline.example/")).rejects.toThrow("That address isn't allowed.");
    expect(serve).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/library",
  useSearchParams: () => new URLSearchParams(),
}));
// The server render sees the provider's first state: signed out, config not loaded yet.
vi.mock("@/contexts/AuthContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ capabilities: null, isAuthenticated: false, isLoading: true, user: null }),
}));

import Home, { metadata as homeMetadata } from "@/app/page";
import LibraryPage, { metadata as libraryMetadata } from "@/app/library/page";
import PricingPage, { metadata as pricingMetadata } from "@/app/pricing/page";
import sitemap from "@/app/sitemap";
import { catalogGroups, practiceHref } from "@/components/library/LibraryCatalog";
import { LANDINGS } from "@/lib/landing";
import { LIBRARY } from "@/lib/personas";
import { safeNextPath } from "@/lib/safeNext";

afterEach(() => vi.unstubAllEnvs());

const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const titleOf = (m: { title?: unknown }) => (m.title as { absolute: string }).absolute;

describe("homepage H1", () => {
  it("is the hosted pitch, with the title unchanged", () => {
    expect(h1s(renderToStaticMarkup(createElement(Home)))).toEqual(["Hosted AI sales call practice, no setup."]);
    expect(titleOf(homeMetadata)).toBe("Real-Time Call Trainer · Hosted AI sales call practice, no setup");
  });
});

describe("pricing H1", () => {
  it("names the three plans, with the title unchanged", () => {
    expect(h1s(renderToStaticMarkup(createElement(PricingPage)))).toEqual(["Call Trainer pricing: Free, Pro, and Team."]);
    expect(titleOf(pricingMetadata)).toBe("Pricing: Free, Pro and Team Plans | Call Trainer");
  });
});

describe("vertical heroes", () => {
  it("gives solar and home services their own H1", () => {
    expect(LANDINGS.solar.hero).toBe("Practice the solar homeowner call that usually stalls");
    expect(LANDINGS["home-services"].hero).toBe("Practice the HVAC, remodel, and pest call that usually stalls");
  });

  it("keeps every vertical hero unique", () => {
    const heroes = Object.values(LANDINGS).map((l) => l.hero);
    expect(new Set(heroes).size).toBe(heroes.length);
  });
});

describe("sitemap", () => {
  it("lists /library and /compete on the canonical origin", () => {
    vi.stubEnv("APP_URL", "");
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://calltrainer.tech/library");
    expect(urls).toContain("https://calltrainer.tech/compete");
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("/library", () => {
  const families = new Set(LIBRARY.map((s) => s.role)).size;

  it("keeps its title and adds its own description and canonical", () => {
    expect(titleOf(libraryMetadata)).toBe("Persona library · Real-Time Call Trainer");
    expect(libraryMetadata.description).not.toBe(homeMetadata.description);
    expect(libraryMetadata.description).toContain(`${LIBRARY.length} AI buyer personas across ${families} sales jobs`);
    expect(libraryMetadata.alternates?.canonical).toBe("https://calltrainer.tech/library");
  });

  it("server-renders the H1 and the full built-in catalog for signed-out readers", () => {
    const html = renderToStaticMarkup(createElement(LibraryPage));
    const text = decode(html);
    expect(h1s(html)).toEqual(["Persona library"]);
    expect(html).not.toContain("Loading personas");
    for (const s of LIBRARY) {
      expect(text, s.id).toContain(s.aiPersona.name);
      expect(text, s.id).toContain(s.aiPersona.role);
      expect(text, s.id).toContain(s.title);
      expect(text, s.id).toContain(practiceHref(s.id));
    }
    for (const ind of new Set(LIBRARY.map((s) => s.industry).filter(Boolean))) expect(text, ind).toContain(ind);
  });

  it("lists only built-in personas, grouped by job family", () => {
    const custom = { ...LIBRARY[0], id: "custom-private-1", builtIn: false, title: "Private persona" };
    const groups = catalogGroups([...LIBRARY, custom]);
    const ids = groups.flatMap((g) => g.items.map((s) => s.id));
    expect(ids).not.toContain("custom-private-1");
    expect(ids.length).toBe(LIBRARY.length);
    expect(groups.length).toBe(families);
  });

  it("sends practice links through sign-in with a safe next path", () => {
    const href = practiceHref(LIBRARY[0].id);
    const next = new URL(href, "http://x.invalid").searchParams.get("next");
    expect(href.startsWith("/login?next=")).toBe(true);
    expect(safeNextPath(next, "")).toBe(`/trainer?scenario=${encodeURIComponent(LIBRARY[0].id)}`);
  });

  it("no longer redirects signed-out readers away from the catalog", () => {
    const src = readFileSync("src/components/library/LibraryClient.tsx", "utf8");
    expect(src).not.toContain('router.replace("/login")');
    expect(src).toMatch(/!isAuthenticated\) return fallback/);
  });
});

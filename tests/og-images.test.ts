import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as home from "@/app/opengraph-image";
import * as homeTwitter from "@/app/twitter-image";
import * as vertical from "@/app/for/[vertical]/opengraph-image";
import * as verticalTwitter from "@/app/for/[vertical]/twitter-image";
import { LANDINGS } from "@/lib/landing";
import { isPublicPath, VERTICAL_SLUGS } from "@/lib/publicPaths";
import { paletteFromCss } from "@/lib/shareCard";

describe("share image routes", () => {
  it.each([
    ["home opengraph", home],
    ["home twitter", homeTwitter],
    ["vertical opengraph", vertical],
    ["vertical twitter", verticalTwitter],
  ])("%s exports 1200x630 PNG", (_name, mod) => {
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(mod.contentType).toBe("image/png");
    expect(typeof mod.default).toBe("function");
  });

  it("vertical routes pre-render every vertical", () => {
    expect(vertical.generateStaticParams().map((p) => p.vertical)).toEqual([...VERTICAL_SLUGS]);
    expect(verticalTwitter.generateStaticParams()).toEqual(vertical.generateStaticParams());
  });

  it("every vertical has a hero headline to draw", () => {
    for (const s of VERTICAL_SLUGS) expect(LANDINGS[s].hero.length).toBeGreaterThan(0);
  });

  it.each(VERTICAL_SLUGS)("keeps /for/%s images public", (s) => {
    expect(isPublicPath(`/for/${s}/opengraph-image`)).toBe(true);
    expect(isPublicPath(`/for/${s}/opengraph-image-1a2b3c`)).toBe(true);
    expect(isPublicPath(`/for/${s}/twitter-image`)).toBe(true);
  });

  it("does not open other paths under /for", () => {
    expect(isPublicPath("/for/unknown/opengraph-image")).toBe(false);
    expect(isPublicPath("/for/insurance/other")).toBe(false);
  });
});

describe("share image URLs", () => {
  it("stay on APP_URL even on a Vercel preview", async () => {
    const saved = { ...process.env };
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "preview-abc.vercel.app";
    process.env.APP_URL = "https://calltrainer.tech";
    try {
      const { pageMetadata, shareImages } = await import("@/lib/seo");
      type Imgs = { images: { url: string }[] };
      const root = pageMetadata({ title: "t", description: "d", path: "/" });
      const ins = pageMetadata({ title: "t", description: "d", path: "/for/insurance", imagePath: "/for/insurance" });
      const urls = [
        ...shareImages("/").openGraph,
        ...shareImages("/for/insurance").twitter,
        ...(root.openGraph as unknown as Imgs).images,
        ...(ins.openGraph as unknown as Imgs).images,
        ...(ins.twitter as unknown as Imgs).images,
      ].map((i) => i.url);
      for (const u of urls) expect(u.startsWith("https://calltrainer.tech/")).toBe(true);
      expect(urls).toContain("https://calltrainer.tech/for/insurance/opengraph-image");
    } finally {
      process.env = saved;
    }
  });
});

describe("paletteFromCss", () => {
  it("reads the deck tokens from globals.css", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const p = paletteFromCss(css);
    for (const v of Object.values(p)) expect(v).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(p.bg).toBe("rgb(10, 15, 26)");
  });

  it("throws when the block or a token is missing", () => {
    expect(() => paletteFromCss(":root { --bg: 1 2 3; }")).toThrow(/no .deck/);
    expect(() => paletteFromCss(".deck, :root[data-theme=\"dark\"] { --bg: 1 2 3; }")).toThrow(/--ink/);
  });
});

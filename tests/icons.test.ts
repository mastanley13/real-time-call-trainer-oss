import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PricingCards from "@/components/landing/PricingCards";

const tsx = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsx(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));
const files = [...tsx("src/app"), ...tsx("src/components")];

describe("icon set", () => {
  it.each(files)("%s uses no AI-flavored icons or emoji icons", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/\b(Sparkles?|WandSparkles|Wand2?|Stars|Bot|BrainCircuit)\b(?=[\s,}])/);
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(src).not.toContain("▲");
  });

  it("create persona actions read New persona with UserPlus, drafting uses PenLine, the model chip uses Cpu", () => {
    const library = readFileSync("src/components/library/LibraryClient.tsx", "utf8");
    const palette = readFileSync("src/components/CommandPalette.tsx", "utf8");
    const wizard = readFileSync("src/components/library/PersonaWizard.tsx", "utf8");
    expect(library.match(/<UserPlus [^>]*\/>\s*(?:<\/span>\s*<span>\s*<span[^>]*>)?\s*New persona</g)?.length).toBe(3);
    expect(library + palette).not.toMatch(/with AI|Create with AI/);
    expect(palette).toContain('to("new", "New persona", "/library/new", UserPlus');
    expect(wizard).toMatch(/<PenLine [^>]*\/> Draft persona/);
    expect(wizard).toMatch(/className="chip-model"><Cpu /);
  });
});

describe("pricing card coming-soon row", () => {
  it("uses the same ink-soft text as the other rows (10.4:1), not ink-muted", () => {
    const html = renderToStaticMarkup(createElement(PricingCards, { billingEnabled: false }));
    const li = html.slice(html.lastIndexOf("<li", html.indexOf("Reviewed persona packs (coming soon)")), html.indexOf("Reviewed persona packs (coming soon)"));
    expect(li).toMatch(/^<li class="flex gap-2">/);
  });
});

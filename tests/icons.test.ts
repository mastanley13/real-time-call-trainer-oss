import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PricingCards from "@/components/landing/PricingCards";

const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
const srcFiles = walk("src", /\.(ts|tsx)$/);
const uiFiles = [...walk("src/app", /\.tsx$/), ...walk("src/components", /\.tsx$/)];

/** Generic AI glyphs, never allowed (docs/ICONS.md). Matched after stripping lucide's Lucide prefix and Icon suffix. */
const BANNED = /^(Sparkles?|Wand\w*|Bot\w*|Brain\w*|Star\w*)$/;

/** Every icon name a source file imports from lucide-react: named imports (aliases resolved to the imported name) and deep imports. */
function lucideImports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name.replace(/^Lucide(?=[A-Z])/, "").replace(/(?<=.)Icon$/, ""));
    }
  }
  for (const m of src.matchAll(/from\s*["']lucide-react\/[^"']*\/([a-z0-9-]+)(?:\.js)?["']/g)) {
    names.push(m[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(""));
  }
  return names;
}

describe("lucideImports", () => {
  it("finds named, aliased, prefixed, multi-line and deep imports", () => {
    const src = `import { Check,\n  Sparkles as Shine, type LucideIcon, WandSparklesIcon } from "lucide-react";\nimport Bot from "lucide-react/dist/esm/icons/bot-message-square";`;
    // LucideIcon is the type; stripping the prefix leaves "Icon", which is not banned.
    expect(lucideImports(src)).toEqual(["Check", "Sparkles", "Icon", "WandSparkles", "BotMessageSquare"]);
    expect(lucideImports(src).filter((n) => BANNED.test(n))).toEqual(["Sparkles", "WandSparkles", "BotMessageSquare"]);
  });
});

describe("icon set", () => {
  it.each(srcFiles)("%s imports no AI-glyph icons from lucide-react", (f) => {
    expect(lucideImports(readFileSync(f, "utf8")).filter((n) => BANNED.test(n))).toEqual([]);
  });

  it.each(srcFiles)("%s uses lucide-react as the only icon package", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/from\s*["'](@phosphor-icons|@tabler\/icons|@heroicons|@radix-ui\/react-icons|@remixicon|react-icons)/);
  });

  it.each(uiFiles)("%s has no emoji or glyph icons", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(src).not.toContain("▲");
  });

  it("uses the literal icon for each action", () => {
    const read = (f: string) => readFileSync(f, "utf8");
    const library = read("src/components/library/LibraryClient.tsx");
    const palette = read("src/components/CommandPalette.tsx");
    const wizard = read("src/components/library/PersonaWizard.tsx");
    // Create persona: UserPlus with a verb+noun label.
    expect(library.match(/<UserPlus [^>]*\/>\s*(?:<\/span>\s*<span>\s*<span[^>]*>)?\s*New persona</g)?.length).toBe(3);
    expect(library + palette).not.toMatch(/with AI/);
    expect(palette).toContain('to("new", "New persona", "/library/new", UserPlus');
    // Persona library: BookOpen (docs/ICONS.md), on every surface that shows it. Calls: Phone.
    expect(palette).toContain('"/library", BookOpen');
    expect(read("src/components/MobileTabBar.tsx")).toContain('"/library": BookOpen');
    expect(read("src/app/page.tsx")).toContain("{ icon: BookOpen, title: `${LIBRARY.length} personas");
    expect(srcFiles.filter((f) => lucideImports(read(f)).includes("IdCard"))).toEqual([]);
    expect(library.match(/<Phone [^>]*\/> Start practice</g)?.length).toBe(2);
    expect(wizard).toMatch(/<Phone [^>]*\/> Save and test call/);
    // Drafting: PenLine. Model chip: Cpu. Coach: MessageSquare. Grading: ClipboardCheck.
    expect(wizard).toMatch(/<PenLine [^>]*\/> Draft persona/);
    expect(wizard).toMatch(/className="chip-model"><Cpu /);
    expect(read("src/components/settings/ModelsClient.tsx")).toContain("{ coach: MessageSquare, grading: ClipboardCheck, wizard: PenLine, caller: Phone }");
    expect(read("src/components/call/CopilotRail.tsx")).toContain("whisper: MessageSquare");
  });
});

describe("pricing card coming-soon row", () => {
  it("uses the same ink-soft text as the other rows (10.4:1), not ink-muted", () => {
    const html = renderToStaticMarkup(createElement(PricingCards, { billingEnabled: false }));
    const li = html.slice(html.lastIndexOf("<li", html.indexOf("Reviewed persona packs (coming soon)")), html.indexOf("Reviewed persona packs (coming soon)"));
    expect(li).toMatch(/^<li class="flex gap-2">/);
  });
});

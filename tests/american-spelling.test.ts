import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Product copy, AI prompts, persona packs and comments use American spelling. This guard scans src (code, comments and
 * markdown) for the British "practise" family and a few other unambiguous British spellings, and reports each hit as
 * "file:line: snippet".
 *
 * A few identifiers and keys keep the British spelling on purpose (renaming them would change a data shape or an API
 * value). Each is allowed only as one exact, whole code line in one exact file (compared after trimming). Any other
 * line, and any edit to an allowed line (a string, template text, JSX text or comment added to it, or the identifier
 * moved into one), no longer matches and fails.
 */

const PRACTISE_RE = /practis/i;
// Other British spellings that never occur in American copy. Identifiers such as `cancelled` and `analyse` are not listed.
const OTHER_BRITISH_RE =
  /colour|behaviour|\borganis(?:e|ed|es|ing|ation)|favour|neighbour|\bdefence|\boffence|\blicence|\blabell(?:ed|ing)\b|\bmodell(?:ed|ing)\b|\btravell(?:ed|ing)\b|honour|rumour|\bcentre|\btheatre|\bnormalis|\bsummaris|\brecognis|\bpenalis|\bcustomis/i;

/** Identifiers and keys that must keep the British spelling. Exact files, narrow patterns, nothing else skipped. */
const ALLOWED_LINES: Record<string, string[]> = {
  // TeamOverview.kpis.coverage is `{ practised, library, pct }`, an API shape that tests/team.test.ts pins.
  "src/lib/team.ts": [
    "coverage: { practised: number; library: number; pct: number };",
    "const practised = new Set(windowed.map((s) => s.scenarioId).filter((id) => library.has(id)));",
    "coverage: { practised: practised.size, library: library.size, pct: library.size ? Math.round((practised.size / library.size) * 100) : 0 },",
  ],
  "src/components/team/TeamKpis.tsx": [
    '{ label: "Persona coverage", value: String(kpis.coverage.practised), of: `of ${kpis.coverage.library}`, caption: `library personas practiced (${kpis.coverage.pct}%)`, fill: kpis.coverage.pct, tone: "bg-primary" },',
  ],
  // `savePrivate(thenPractise)` is a parameter name only.
  "src/components/library/PersonaWizard.tsx": [
    "function savePrivate(thenPractise: boolean) {",
    "if (thenPractise) router.push(`/trainer?scenario=${encodeURIComponent(draft.id)}`);",
  ],
};

const ROOT = process.cwd();

function sourceFiles(dir = join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:tsx?|jsx?|md)$/.test(e.name)) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

const isAllowedLine = (file: string, line: string) => (ALLOWED_LINES[file] ?? []).includes(line.trim());

function britishHits(files: string[], re: RegExp, read: (f: string) => string = (f) => readFileSync(join(ROOT, f), "utf8")): string[] {
  return files.flatMap((f) =>
    read(f)
      .split("\n")
      .flatMap((line, i) => (re.test(line) && !isAllowedLine(f, line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 120)}`] : [])),
  );
}

describe("the practise pattern", () => {
  it.each(["practise", "practising", "practised", "practises", "Practise", "Practise this next", "Never practised", "PRACTISING"])("catches %s", (text) => {
    expect(text).toMatch(PRACTISE_RE);
  });

  it.each(["practice", "practicing", "practiced", "Practice this next", "practical"])("leaves %s alone", (text) => {
    expect(text).not.toMatch(PRACTISE_RE);
  });
});

describe("the allowlist is precise", () => {
  const read = (text: string) => () => text;

  const kpiLine = ALLOWED_LINES["src/components/team/TeamKpis.tsx"][0];

  it("lets the exact allowed code lines through", () => {
    expect(britishHits(["src/components/team/TeamKpis.tsx"], PRACTISE_RE, read(`    ${kpiLine}`))).toEqual([]);
    expect(britishHits(["src/lib/team.ts"], PRACTISE_RE, read("  coverage: { practised: number; library: number; pct: number };"))).toEqual([]);
    expect(britishHits(["src/components/library/PersonaWizard.tsx"], PRACTISE_RE, read("  function savePrivate(thenPractise: boolean) {"))).toEqual([]);
  });

  it("still flags new British copy on the same line or in the same file", () => {
    const line = kpiLine.replace("practiced (", "practised (");
    expect(britishHits(["src/components/team/TeamKpis.tsx"], PRACTISE_RE, read(line))).toHaveLength(1);
    expect(britishHits(["src/components/team/TeamKpis.tsx"], PRACTISE_RE, read("<span>Practise</span>"))).toHaveLength(1);
    expect(britishHits(["src/lib/team.ts"], PRACTISE_RE, read("/** People who have practised it. */"))).toHaveLength(1);
  });

  it("flags the allowed identifier when it is used as text rather than code", () => {
    const file = "src/components/team/TeamKpis.tsx";
    expect(britishHits([file], PRACTISE_RE, read("<span>kpis.coverage.practised</span>"))).toHaveLength(1);
    expect(britishHits([file], PRACTISE_RE, read('const label = "kpis.coverage.practised";'))).toHaveLength(1);
    expect(britishHits([file], PRACTISE_RE, read(`${kpiLine} // kpis.coverage.practised`))).toHaveLength(1);
    expect(britishHits([file], PRACTISE_RE, read(kpiLine.replace("tone:", "title: `kpis.coverage.practised`, tone:")))).toHaveLength(1);
    expect(britishHits(["src/lib/team.ts"], PRACTISE_RE, read('const m = "coverage: { practised: number; library: number; pct: number };";'))).toHaveLength(1);
    expect(britishHits(["src/components/library/PersonaWizard.tsx"], PRACTISE_RE, read("<p>thenPractise</p>"))).toHaveLength(1);
  });

  it("does not extend one file's allowance to another", () => {
    expect(britishHits(["src/components/library/LibraryClient.tsx"], PRACTISE_RE, read("savePrivate(thenPractise)"))).toHaveLength(1);
    expect(britishHits(["src/components/library/LibraryClient.tsx"], PRACTISE_RE, read("<Link>Practise</Link>"))).toHaveLength(1);
    expect(britishHits(["src/components/library/PersonaWizard.tsx"], PRACTISE_RE, read("<button>Practise</button>"))).toHaveLength(1);
  });

  it("reports hits as file:line: snippet", () => {
    expect(britishHits(["src/app/x.tsx"], PRACTISE_RE, read("a\n  <p>Keep practising.</p>"))).toEqual(["src/app/x.tsx:2: <p>Keep practising.</p>"]);
  });
});

describe("American spelling in src", () => {
  const files = sourceFiles();

  it("scans a real tree", () => {
    expect(files).toContain("src/app/page.tsx");
    expect(files).toContain("src/lib/team.ts");
    expect(files).toContain("src/components/team/TeamKpis.tsx");
    expect(files).toContain("src/components/library/PersonaWizard.tsx");
    expect(files.some((f) => f.startsWith("src/lib/personas/"))).toBe(true);
    expect(files.some((f) => f.startsWith("docs/redesign"))).toBe(false);
  });

  it("has no practise, practising or practised outside the allowed identifiers", () => {
    expect(britishHits(files, PRACTISE_RE)).toEqual([]);
  });

  it("has no other unambiguous British spellings", () => {
    expect(britishHits(files, OTHER_BRITISH_RE)).toEqual([]);
  });
});

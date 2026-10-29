/**
 * Ranking for the command palette (src/components/CommandPalette.tsx).
 *
 * Pure: no DOM, no storage, so it runs in tests and on either side of the
 * app. Every query word must match some field; each word scores by its best
 * match tier times the field weight, and a multi-word query gets a bonus when
 * the whole phrase appears in one field.
 */
import { OBJECTION_LABELS, jobFamilyLabel, type Scenario } from "./scenarios";

export interface SearchField { text: string; weight: number }
export interface Ranked<T> { item: T; score: number }
export interface IndexEntry<T> { item: T; fields: SearchField[] }

/** Lowercase, drop accents and punctuation, so "Status quo", "status_quo" and "status-quo" compare equal. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const tokenize = (query: string): string[] => normalize(query).split(" ").filter(Boolean);

/**
 * Match tiers, strongest first. The gaps are wide on purpose: a prefix hit in a
 * light field (title, x2) still outranks a mid-word hit in the heaviest one (name, x3).
 */
export const TIER = { exact: 100, prefix: 80, word: 65, wordStart: 60, acronym: 45, substring: 25, fuzzy: 10 } as const;

/** Letters of `needle` appear in order inside `hay` (typo-tolerant fallback). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

/** Best tier for one query word against one normalized text, or 0 when it does not match at all. */
export function matchTier(token: string, text: string): number {
  if (!token || !text) return 0;
  if (text === token) return TIER.exact;
  if (text.startsWith(token)) return TIER.prefix;
  const words = text.split(" ");
  if (words.includes(token)) return TIER.word;
  if (words.some((w) => w.startsWith(token))) return TIER.wordStart;
  // "hs" finds "home services", "ae" finds "account executive".
  if (token.length >= 2 && words.map((w) => w[0]).join("").includes(token)) return TIER.acronym;
  if (text.includes(token)) return TIER.substring;
  // Fuzzy only inside one word that starts with the same letter, so "dna" finds "dana" but short queries stay precise.
  if (token.length >= 3 && words.some((w) => w[0] === token[0] && w.length <= token.length * 3 && isSubsequence(token, w))) return TIER.fuzzy;
  return 0;
}

/** Normalize each item's fields once, so ranking on every keystroke only compares strings. */
export function createIndex<T>(items: readonly T[], fieldsOf: (item: T) => SearchField[]): IndexEntry<T>[] {
  return items.map((item) => ({
    item,
    fields: fieldsOf(item).map((f) => ({ text: normalize(f.text), weight: f.weight })).filter((f) => f.text),
  }));
}

/** Score of one entry for already-tokenized words; 0 means "leave it out". */
export function scoreEntry(tokens: string[], fields: SearchField[]): number {
  if (!tokens.length) return 0;
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const f of fields) best = Math.max(best, matchTier(t, f.text) * f.weight);
    if (!best) return 0;
    total += best;
  }
  if (tokens.length > 1) {
    // "status quo" should prefer an item that says it as one phrase over one that has both words apart.
    const phrase = tokens.join(" ");
    let bonus = 0;
    for (const f of fields) {
      const tier = f.text === phrase ? TIER.exact : f.text.startsWith(phrase) ? TIER.prefix : f.text.includes(` ${phrase}`) ? TIER.wordStart : f.text.includes(phrase) ? TIER.substring : 0;
      bonus = Math.max(bonus, tier * f.weight);
    }
    total += bonus;
  }
  return total;
}

/** Matching entries, best first; ties keep the index order. An empty query returns everything in index order. */
export function search<T>(index: readonly IndexEntry<T>[], query: string, limit = Infinity): Ranked<T>[] {
  const tokens = tokenize(query);
  if (!tokens.length) return index.slice(0, limit).map((e) => ({ item: e.item, score: 0 }));
  const hits: (Ranked<T> & { order: number })[] = [];
  index.forEach((e, order) => {
    const score = scoreEntry(tokens, e.fields);
    if (score > 0) hits.push({ item: e.item, score, order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ item, score }) => ({ item, score }));
}

/** One-shot convenience for callers that rank a list once. */
export function rank<T>(items: readonly T[], query: string, fieldsOf: (item: T) => SearchField[], limit = Infinity): Ranked<T>[] {
  return search(createIndex(items, fieldsOf), query, limit);
}

/** What the palette searches on a persona: name, scenario title, job family, industry and objection types. */
export function personaFields(s: Scenario): SearchField[] {
  return [
    { text: s.aiPersona.name, weight: 3 },
    { text: s.title, weight: 2 },
    { text: jobFamilyLabel(s.role), weight: 1.5 },
    { text: s.industry, weight: 1.5 },
    // Label and id both, so "no need" and "need", "status quo" and "status_quo" all land.
    ...[...new Set(s.objections.map((o) => o.type))].flatMap((t) => [
      { text: OBJECTION_LABELS[t], weight: 1.2 },
      { text: t, weight: 1.2 },
    ]),
  ];
}

/** What the palette searches on a command: its label first, then looser keywords. */
export function commandFields(c: { label: string; keywords?: string }): SearchField[] {
  return [{ text: c.label, weight: 3 }, { text: c.keywords ?? "", weight: 1 }];
}

export type ThemeChoice = "system" | "light" | "dark";

/** The palette's toggle flips what the viewer sees now, so "system" first resolves through prefers-color-scheme. */
export function toggledTheme(current: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  const effective = current === "system" ? (prefersDark ? "dark" : "light") : current;
  return effective === "dark" ? "light" : "dark";
}

/** Ctrl+K or Cmd+K with no other modifier. Autofill can fire keydown without a key, hence the type check. */
export function isPaletteShortcut(e: { key?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return typeof e.key === "string" && e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

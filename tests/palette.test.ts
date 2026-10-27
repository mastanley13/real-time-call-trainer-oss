import { describe, expect, it } from "vitest";
import {
  TIER, commandFields, createIndex, isPaletteShortcut, matchTier, normalize, personaFields, rank, search, toggledTheme,
} from "@/lib/palette";
import { BUILT_IN_SCENARIOS, type ObjectionType, type Scenario } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";

/** A real built-in with just the searchable fields swapped, so personaFields sees a valid Scenario. */
function persona(id: string, name: string, over: { title?: string; role?: string; industry?: string; objections?: ObjectionType[] } = {}): Scenario {
  const base = BUILT_IN_SCENARIOS[0];
  return {
    ...base,
    id,
    title: over.title ?? "Discovery call",
    role: over.role ?? "general",
    industry: over.industry ?? "Software",
    aiPersona: { ...base.aiPersona, name },
    objections: (over.objections ?? []).map((type) => ({ type, line: "x", prepAnswer: "" })),
  };
}
const ids = (r: { item: Scenario }[]) => r.map((x) => x.item.id);

describe("normalize", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalize("Status_quo")).toBe("status quo");
    expect(normalize("  Café-Owner's  ")).toBe("cafe owners");
    expect(normalize("Customer success & renewals")).toBe("customer success renewals");
  });
});

describe("matchTier", () => {
  it("orders exact > prefix > whole word > word start > acronym > substring > fuzzy > none", () => {
    expect(matchTier("price", "price")).toBe(TIER.exact);
    expect(matchTier("pri", "priya raman")).toBe(TIER.prefix);
    expect(matchTier("raman", "priya raman")).toBe(TIER.word);
    expect(matchTier("ram", "priya raman")).toBe(TIER.wordStart);
    expect(matchTier("hs", "home services")).toBe(TIER.acronym);
    expect(matchTier("ram", "abramson cole")).toBe(TIER.substring);
    expect(matchTier("dna", "dana whitfield")).toBe(TIER.fuzzy);
    expect(matchTier("xyz", "dana whitfield")).toBe(0);
    const order = [TIER.exact, TIER.prefix, TIER.word, TIER.wordStart, TIER.acronym, TIER.substring, TIER.fuzzy];
    expect([...order].sort((a, b) => b - a)).toEqual(order);
  });

  it("keeps fuzzy matching tight for short or unrelated words", () => {
    expect(matchTier("dn", "dana")).toBe(0);
    expect(matchTier("mrtg", "mortgage lending")).toBe(TIER.fuzzy);
    expect(matchTier("dna", "documentation and")).toBe(0);
  });
});

describe("rank personas", () => {
  it("puts a prefix match ahead of a substring match", () => {
    const list = [persona("april", "April Stone"), persona("priya", "Priya Raman")];
    expect(ids(rank(list, "pri", personaFields))).toEqual(["priya", "april"]);
  });

  it("puts a word-start match ahead of a mid-word match", () => {
    const list = [persona("abramson", "Abramson Cole"), persona("priya", "Priya Raman")];
    expect(ids(rank(list, "ram", personaFields))).toEqual(["priya", "abramson"]);
  });

  it("prefers a prefix in a lighter field over a substring in the name", () => {
    const list = [persona("name-hit", "Caprice Hill"), persona("title-hit", "Jo Park", { title: "Pricing pushback on renewal" })];
    expect(ids(rank(list, "pric", personaFields))[0]).toBe("title-hit");
  });

  it("requires every word of a multi-word query to match", () => {
    const list = [
      persona("solar-price", "Ana Ruiz", { role: "solar", industry: "Residential solar", objections: ["price"] }),
      persona("solar-only", "Ben Ito", { role: "solar", industry: "Residential solar", objections: ["timing"] }),
      persona("price-only", "Cy Moss", { role: "insurance", industry: "Auto insurance", objections: ["price"] }),
    ];
    expect(ids(rank(list, "solar price", personaFields))).toEqual(["solar-price"]);
    expect(ids(rank(list, "price", personaFields)).sort()).toEqual(["price-only", "solar-price"]);
  });

  it("matches objection types by label and by id", () => {
    const list = [
      persona("sq", "Dee Lane", { objections: ["status_quo"] }),
      persona("need", "Eli Ford", { objections: ["need"] }),
      persona("comp", "Flo Grant", { objections: ["competitor", "price"] }),
    ];
    expect(ids(rank(list, "status quo", personaFields))).toEqual(["sq"]);
    expect(ids(rank(list, "status_quo", personaFields))).toEqual(["sq"]);
    expect(ids(rank(list, "no need", personaFields))).toEqual(["need"]);
    expect(ids(rank(list, "competitor", personaFields))).toEqual(["comp"]);
  });

  it("gives a bonus when the whole phrase sits in one field", () => {
    const list = [
      persona("apart", "Gil Park", { title: "Status update on the quo warranto filing" }),
      persona("together", "Hal Moore", { title: "Fighting the status quo" }),
    ];
    expect(ids(rank(list, "status quo", personaFields))[0]).toBe("together");
  });

  it("finds job families and industries, including by acronym", () => {
    const list = [persona("hs", "Ida Bell", { role: "home-services", industry: "Plumbing" }), persona("ae", "Jon Ray", { role: "ae" })];
    expect(ids(rank(list, "home serv", personaFields))).toEqual(["hs"]);
    expect(ids(rank(list, "plumb", personaFields))).toEqual(["hs"]);
    expect(ids(rank(list, "ae discovery", personaFields))).toEqual(["ae"]);
  });

  it("returns everything in order for an empty query and respects the limit", () => {
    const list = [persona("a", "Ann"), persona("b", "Bea"), persona("c", "Cal")];
    expect(ids(rank(list, "   ", personaFields))).toEqual(["a", "b", "c"]);
    expect(ids(rank(list, "", personaFields, 2))).toEqual(["a", "b"]);
  });

  it("keeps the original order on ties", () => {
    const list = [persona("one", "Sam Lee"), persona("two", "Sam Lee"), persona("three", "Sam Lee")];
    expect(ids(rank(list, "sam", personaFields))).toEqual(["one", "two", "three"]);
  });

  it("ranks the real library sensibly", () => {
    const index = createIndex(LIBRARY, personaFields);
    const mortgage = search(index, "mortgage");
    expect(mortgage.length).toBeGreaterThan(0);
    expect(mortgage[0].item.role).toBe("mortgage");
    const dana = search(index, "dana");
    expect(dana[0].item.aiPersona.name.toLowerCase().startsWith("dana")).toBe(true);
    expect(search(index, "zzqx")).toEqual([]);
  });
});

describe("commands", () => {
  const cmds = [
    { label: "Library", keywords: "personas browse" },
    { label: "Toggle theme", keywords: "dark light mode appearance" },
    { label: "Security", keywords: "settings mfa password" },
  ];
  it("matches labels before keywords", () => {
    expect(rank(cmds, "lib", commandFields)[0].item.label).toBe("Library");
    expect(rank(cmds, "dark", commandFields).map((r) => r.item.label)).toEqual(["Toggle theme"]);
    expect(rank(cmds, "mfa", commandFields).map((r) => r.item.label)).toEqual(["Security"]);
  });
});

describe("toggledTheme", () => {
  it("flips what is on screen", () => {
    expect(toggledTheme("light", true)).toBe("dark");
    expect(toggledTheme("dark", false)).toBe("light");
    expect(toggledTheme("system", true)).toBe("light");
    expect(toggledTheme("system", false)).toBe("dark");
  });
});

describe("isPaletteShortcut", () => {
  const k = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  it("accepts Ctrl+K and Cmd+K only", () => {
    expect(isPaletteShortcut(k({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(k({ metaKey: true, key: "K" }))).toBe(true);
    expect(isPaletteShortcut(k({}))).toBe(false);
    expect(isPaletteShortcut(k({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(k({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(k({ ctrlKey: true, key: "j" }))).toBe(false);
    expect(isPaletteShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false);
  });
});

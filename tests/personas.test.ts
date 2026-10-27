import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY } from "@/lib/personas";
import { BUILT_IN_SCENARIOS, JOB_FAMILIES, OBJECTION_TYPES, ScenarioSchema, talkTrackSteps, type Scenario } from "@/lib/scenarios";

const FAMILY_IDS = new Set<string>(JOB_FAMILIES.map((f) => f.id));
const BUILT_IN_IDS = new Set(BUILT_IN_SCENARIOS.map((s) => s.id));
const PACK_DIR = path.resolve(__dirname, "../src/lib/personas");
/** One pack file per job family, named after the family id. */
const PACK_FILES = readdirSync(PACK_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts");

async function loadPack(file: string): Promise<Scenario[]> {
  const mod = (await import(path.join(PACK_DIR, file))) as { default: Scenario[] };
  return mod.default;
}

describe("persona library", () => {
  it("has a pack for every job family except general", () => {
    const packFamilies = PACK_FILES.map((f) => f.replace(/\.ts$/, "")).sort();
    const expected = JOB_FAMILIES.map((f) => f.id).filter((id) => id !== "general").sort();
    expect(packFamilies).toEqual(expected);
  });

  it("loads the built-ins first and then every pack", () => {
    expect(LIBRARY.slice(0, BUILT_IN_SCENARIOS.length).map((s) => s.id)).toEqual(BUILT_IN_SCENARIOS.map((s) => s.id));
    expect(LIBRARY.length).toBeGreaterThan(50);
    expect(LIBRARY.every((s) => s.builtIn === true)).toBe(true);
  });

  it("uses unique persona ids", () => {
    const ids = LIBRARY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every persona a different first name", () => {
    // A title such as "Dr." is not a first name.
    const firstName = (name: string) => name.replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(/\s+/)[0].toLowerCase();
    const byName = new Map<string, string[]>();
    for (const s of LIBRARY) {
      const first = firstName(s.aiPersona.name);
      expect(first, `${s.id} has no persona name`).not.toBe("");
      byName.set(first, [...(byName.get(first) ?? []), `${s.aiPersona.name} (${s.id})`]);
    }
    const shared = [...byName.values()].filter((names) => names.length > 1);
    expect(shared, "persona first names used more than once").toEqual([]);
  });

  it.each(PACK_FILES.map((f) => [f]))("%s: every persona parses, sits in its family and is wired into the library", async (file) => {
    const family = file.replace(/\.ts$/, "");
    const pack = await loadPack(file);
    expect(pack.length).toBeGreaterThan(0);
    for (const raw of pack) {
      const parsed = ScenarioSchema.safeParse(raw);
      expect(parsed.success, `${raw.id}: ${parsed.error?.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`).toBe(true);
      expect(raw.role, raw.id).toBe(family);
      expect(raw.id.startsWith(`${family}-`), `${raw.id} should start with "${family}-"`).toBe(true);
      expect(LIBRARY.some((s) => s.id === raw.id), `${raw.id} is missing from LIBRARY`).toBe(true);
    }
  });
});

describe.each(LIBRARY.map((s) => [s.id, s] as const))("persona %s", (_id, s) => {
  it("uses a valid job family", () => {
    expect(FAMILY_IDS.has(s.role)).toBe(true);
  });

  it("has rubric weights that sum to 100 and unique criterion ids", () => {
    expect(s.rubric.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(new Set(s.rubric.map((c) => c.id)).size).toBe(s.rubric.length);
  });

  it("raises at least one objection for the live coach", () => {
    expect(s.objections.length).toBeGreaterThanOrEqual(1);
    for (const o of s.objections) {
      expect(OBJECTION_TYPES).toContain(o.type);
      expect(o.line.trim()).not.toBe("");
    }
  });

  it("has a talk track, an opening line and a goal", () => {
    expect(talkTrackSteps(s.callScript).length).toBeGreaterThan(0);
    expect(s.aiPersona.openingLine.trim()).not.toBe("");
    expect(s.traineeGoal.trim()).not.toBe("");
  });

  if (!BUILT_IN_IDS.has(s.id)) {
    it("has scripted replies for the offline caller", () => {
      expect(s.sampleReplies.length).toBeGreaterThan(0);
    });
  }
});

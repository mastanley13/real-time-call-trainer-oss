/**
 * The open-source persona library: one pack file per sales job family.
 * Add a persona by appending to the right family file (or adding a new one
 * here); every entry is checked against ScenarioSchema when the app loads.
 */
import { BUILT_IN_SCENARIOS, ScenarioSchema, type Scenario } from "../scenarios";
import sdr from "./sdr";
import ae from "./ae";
import cs from "./cs";
import procurement from "./procurement";
import recruiting from "./recruiting";
import logistics from "./logistics";
import telecom from "./telecom";
import insurance from "./insurance";
import mortgage from "./mortgage";
import realEstate from "./real-estate";
import solar from "./solar";
import auto from "./auto";
import medical from "./medical";
import retail from "./retail";
import collections from "./collections";
import financial from "./financial";
import homeServices from "./home-services";

const PACKS: Scenario[][] = [
  sdr, ae, cs, procurement, recruiting, logistics, telecom, insurance, mortgage, realEstate,
  solar, auto, medical, retail, collections, financial, homeServices,
];

function validated(list: Scenario[]): Scenario[] {
  const seen = new Set<string>();
  return list.map((s) => {
    const parsed = ScenarioSchema.parse(s);
    if (seen.has(parsed.id)) throw new Error(`Duplicate persona id in library: ${parsed.id}`);
    seen.add(parsed.id);
    return { ...parsed, builtIn: true };
  });
}

/** Reviewed built-ins first, then every family pack. */
export const LIBRARY: Scenario[] = validated([...BUILT_IN_SCENARIOS, ...PACKS.flat()]);

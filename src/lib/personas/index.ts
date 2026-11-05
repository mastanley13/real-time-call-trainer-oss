/**
 * The open-source persona library: one pack file per sales job family.
 * Add a persona by appending to the right family file (or adding a new one
 * here); every entry is checked against ScenarioSchema when the app loads.
 *
 * A tenant (src/lib/tenant.ts) selects from it: personas.includeOssPacks, a job family filter, drafts on or off, and
 * extra data packs from tenants/<id>/personas/*.json, which the prebuild copies into src/generated/tenant-personas.json.
 */
import dataPacks from "@/generated/tenant-personas.json";
import { tenant } from "../tenant";
import type { TenantConfig } from "../tenant-schema";
import { BUILT_IN_SCENARIOS, DataPersonaSchema, ScenarioSchema, type Scenario } from "../scenarios";
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

/** Reviewed built-ins first, then every OSS family pack. */
export const OSS_PERSONAS: Scenario[] = validated([...BUILT_IN_SCENARIOS, ...PACKS.flat()]);

/** This tenant's data pack personas. Strict at every level (DataPersonaSchema): unknown fields fail, nested ones too. */
export const DATA_PERSONAS: Scenario[] = validated((dataPacks as unknown[]).map((p) => DataPersonaSchema.parse(p)));

/**
 * The personas a tenant offers, in library order: OSS packs (when included), then data packs, kept to the listed job
 * families and, unless showDrafts, to reviewed ones. Throws instead of returning an empty library, so a filter that
 * matches nothing fails the build. Pure.
 */
export function selectLibrary(cfg: TenantConfig["personas"], oss: Scenario[], data: Scenario[]): Scenario[] {
  const all = [...(cfg.includeOssPacks ? oss : []), ...data];
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.id)) throw new Error(`Duplicate persona id in library: ${s.id}`);
    seen.add(s.id);
  }
  const wanted = new Set(cfg.families);
  const kept = all.filter((s) => wanted.has(s.role) && (cfg.showDrafts || s.status !== "draft"));
  if (!kept.length) {
    throw new Error(`personas.families [${cfg.families.join(", ")}] matches no persona${cfg.showDrafts ? "" : " that is reviewed"}. Use job family ids such as "sdr", "ae".`);
  }
  if (cfg.defaultScenarioId && !kept.some((s) => s.id === cfg.defaultScenarioId)) {
    throw new Error(`personas.defaultScenarioId "${cfg.defaultScenarioId}" is not in this tenant's library`);
  }
  return kept;
}

/** Every persona this build carries, before the family and draft filter. The validator checks all of them. */
export const ALL_PERSONAS: Scenario[] = [...(tenant.personas.includeOssPacks ? OSS_PERSONAS : []), ...DATA_PERSONAS];

/** The personas this deployment offers. Grading, team scores and assignments treat only these as library personas. */
export const LIBRARY: Scenario[] = selectLibrary(tenant.personas, OSS_PERSONAS, DATA_PERSONAS);

/**
 * Team persona list: which library personas a team imported and which custom
 * personas a manager created. Pure helpers shared by the routes, onboarding
 * and tests; the browser cache lives in scenarioStore.ts.
 */
import { z } from "zod";
import { JOB_FAMILIES, ScenarioSchema, type Scenario } from "./scenarios";

export const INDUSTRY_IDS = JOB_FAMILIES.map((f) => f.id) as [string, ...string[]];
export const IndustriesSchema = z.array(z.enum(INDUSTRY_IDS)).max(JOB_FAMILIES.length);
export const MAX_TEAM_PERSONAS = 300;
export const MAX_CUSTOM_PERSONAS = 100;
/** Custom team personas get this prefix so they never collide with library or browser-only ids. */
export const TEAM_PERSONA_PREFIX = "team-";

export const ImportSchema = z.object({
  industries: IndustriesSchema.optional(),
  libraryIds: z.array(z.string().trim().min(1).max(80)).max(MAX_TEAM_PERSONAS),
});

export const CreateSchema = z.object({ scenario: ScenarioSchema });

/** One row of GET /api/personas. Library rows carry only the id; the browser has the library. */
export interface TeamPersonaView {
  scenarioId: string;
  source: "library" | "custom";
  title: string;
  role: string;
  scenario?: Scenario;
}

/** Library personas suggested for a set of industries, reviewed ones first, at most `limit`. */
export function suggestForIndustries(library: Scenario[], industries: string[], limit = 60): Scenario[] {
  const wanted = new Set(industries);
  return library
    .filter((s) => wanted.has(s.role))
    .sort((a, b) => Number(b.status === "reviewed") - Number(a.status === "reviewed"))
    .slice(0, limit);
}

/** Keeps only ids that exist in the library, de-duplicated, in input order. */
export function knownLibraryIds(ids: string[], library: Scenario[]): string[] {
  const known = new Set(library.map((s) => s.id));
  return [...new Set(ids)].filter((id) => known.has(id));
}

/** A custom team persona as stored: fresh id, never a built-in, never "reviewed". */
export function asTeamPersona(s: Scenario, newId: string): Scenario {
  return { ...s, id: `${TEAM_PERSONA_PREFIX}${newId}`, builtIn: false, status: "draft" };
}

export function isTeamPersonaId(id: string): boolean {
  return id.startsWith(TEAM_PERSONA_PREFIX);
}

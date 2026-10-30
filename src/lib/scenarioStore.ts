"use client";
/**
 * Persona store for the browser: the library, the team's personas (cached from
 * /api/personas when signed in with a database) and personas saved in this
 * browser only. Library personas are never written.
 */
import { Scenario, ScenarioSchema } from "./scenarios";
import { LIBRARY } from "./personas";
import type { TeamPersonaView } from "./teamPersonas";

const KEY = "rtct.scenarios.v1";
export const TEAM_KEY = "rtct.teamPersonas.v1";
/** Fired on window after the team list changes, so open pages can refresh. */
export const TEAM_PERSONAS_CHANGED = "rtct:team-personas";

export interface TeamCache {
  /** Every persona on the team list: imported library ids and custom team ids. */
  ids: string[];
  custom: Scenario[];
  industries: string[];
  canEdit: boolean;
}
const EMPTY_TEAM: TeamCache = { ids: [], custom: [], industries: [], canEdit: false };

export function loadTeamCache(): TeamCache {
  if (typeof window === "undefined") return EMPTY_TEAM;
  try {
    const raw = JSON.parse(localStorage.getItem(TEAM_KEY) || "null");
    if (!raw || !Array.isArray(raw.ids)) return EMPTY_TEAM;
    const custom = Array.isArray(raw.custom)
      ? raw.custom.flatMap((r: unknown) => {
          const p = ScenarioSchema.safeParse(r);
          return p.success ? [{ ...p.data, builtIn: false }] : [];
        })
      : [];
    return {
      ids: raw.ids.filter((x: unknown): x is string => typeof x === "string"),
      custom,
      industries: Array.isArray(raw.industries) ? raw.industries.filter((x: unknown): x is string => typeof x === "string") : [],
      canEdit: raw.canEdit === true,
    };
  } catch {
    return EMPTY_TEAM;
  }
}

/** Ids on the team's list (imported library personas and custom team personas). */
export function teamScenarioIds(): Set<string> {
  return new Set(loadTeamCache().ids);
}

/** Refreshes the team list from the server. Quietly keeps the old cache when offline or signed out. */
export async function syncTeamPersonas(): Promise<TeamCache> {
  try {
    const r = await fetch("/api/personas", { credentials: "include" });
    if (!r.ok) return loadTeamCache();
    const body = (await r.json()) as { personas?: TeamPersonaView[]; industries?: string[]; canEdit?: boolean; local?: boolean };
    if (body.local) return loadTeamCache();
    const personas = body.personas ?? [];
    const cache: TeamCache = {
      ids: personas.map((p) => p.scenarioId),
      custom: personas.flatMap((p) => (p.source === "custom" && p.scenario ? [{ ...p.scenario, builtIn: false }] : [])),
      industries: body.industries ?? [],
      canEdit: !!body.canEdit,
    };
    try { localStorage.setItem(TEAM_KEY, JSON.stringify(cache)); } catch { /* storage blocked */ }
    window.dispatchEvent(new Event(TEAM_PERSONAS_CHANGED));
    return cache;
  } catch {
    return loadTeamCache();
  }
}

export function clearTeamCache(): void {
  try { localStorage.removeItem(TEAM_KEY); } catch { /* storage blocked */ }
}

/** Saves a persona to the team's list on the server (managers and owners). Throws with the server's message. */
export async function saveTeamPersona(s: Scenario): Promise<Scenario> {
  const r = await fetch("/api/personas", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario: { ...s, builtIn: undefined } }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || "Could not save the persona to your team. Try again.");
  await syncTeamPersonas();
  return (body.persona as TeamPersonaView).scenario ?? s;
}

/** Removes a persona from the team's list (managers and owners). */
export async function removeTeamPersona(id: string): Promise<void> {
  const r = await fetch(`/api/personas?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || "Could not remove the persona. Try again.");
  }
  await syncTeamPersonas();
}

export function loadCustomScenarios(): Scenario[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw)
      ? raw.flatMap((r) => {
          const p = ScenarioSchema.safeParse(r);
          return p.success ? [{ ...p.data, builtIn: false }] : [];
        })
      : [];
  } catch {
    return [];
  }
}

export function listScenarios(): Scenario[] {
  return [...LIBRARY, ...loadTeamCache().custom, ...loadCustomScenarios()];
}

export function saveCustomScenario(s: Scenario): void {
  const others = loadCustomScenarios().filter((x) => x.id !== s.id);
  localStorage.setItem(KEY, JSON.stringify([...others, { ...s, builtIn: false }]));
}

export function deleteCustomScenario(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadCustomScenarios().filter((x) => x.id !== id)));
}

export function duplicateScenario(s: Scenario): Scenario {
  const copy: Scenario = {
    ...structuredClone(s),
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: `${s.title} (copy)`,
    status: "reviewed",
    builtIn: false,
  };
  saveCustomScenario(copy);
  return copy;
}

export function getScenario(id: string): Scenario | undefined {
  return listScenarios().find((s) => s.id === id);
}

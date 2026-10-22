"use client";
/** localStorage-backed custom scenario store. Built-ins are never written. */
import { BUILT_IN_SCENARIOS, Scenario, ScenarioSchema } from "./scenarios";

const KEY = "rtct.scenarios.v1";

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
  return [...BUILT_IN_SCENARIOS, ...loadCustomScenarios()];
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
    builtIn: false,
  };
  saveCustomScenario(copy);
  return copy;
}

export function getScenario(id: string): Scenario | undefined {
  return listScenarios().find((s) => s.id === id);
}

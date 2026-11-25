"use client";
/**
 * Custom scenario persistence: Postgres-backed via /api/scenarios when signed in with a database,
 * falling back to browser localStorage in demo mode or offline setups. Library personas are never written.
 */
import { Scenario, ScenarioSchema } from "./scenarios";
import { LIBRARY } from "./personas";

const KEY = "rtct.scenarios.v1";

export interface ScenarioMeta {
  sharedWithOrg: boolean;
  keepRealNames: boolean;
  sourceUrl: string | null;
  updatedAt: string;
  canEdit: boolean;
  stored: "database" | "local";
}

interface ApiCustomScenarioRecord {
  id: string;
  userId: string;
  organizationId: string | null;
  sharedWithOrg: boolean;
  keepRealNames: boolean;
  sourceUrl: string | null;
  updatedAt: string;
  createdAt: string;
  canEdit: boolean;
  scenario: unknown;
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
  return [...LIBRARY, ...loadCustomScenarios()];
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
    status: "draft",
    builtIn: false,
  };
  saveCustomScenario(copy);
  return copy;
}

export function getScenario(id: string): Scenario | undefined {
  return listScenarios().find((s) => s.id === id);
}

function parseApiRecord(raw: ApiCustomScenarioRecord): { scenario: Scenario; meta: ScenarioMeta } | null {
  const parsed = ScenarioSchema.safeParse(raw?.scenario);
  if (!parsed.success) return null;
  const scenario: Scenario = { ...parsed.data, id: raw.id || parsed.data.id, builtIn: false };
  return {
    scenario,
    meta: {
      sharedWithOrg: !!raw.sharedWithOrg,
      keepRealNames: raw.keepRealNames ?? true,
      sourceUrl: raw.sourceUrl ?? null,
      updatedAt: raw.updatedAt,
      canEdit: raw.canEdit !== false,
      stored: "database",
    },
  };
}

/**
 * Loads all library + custom personas. When `useDatabase` is true, fetches account and org-shared
 * personas from /api/scenarios and merges any browser-only drafts without duplicates.
 */
export async function fetchScenarios(useDatabase: boolean): Promise<{
  scenarios: Scenario[];
  meta: Record<string, ScenarioMeta>;
  persistence: "database" | "local";
}> {
  const local = loadCustomScenarios();
  const meta: Record<string, ScenarioMeta> = {};
  for (const s of local) {
    meta[s.id] = { sharedWithOrg: false, keepRealNames: true, sourceUrl: null, updatedAt: "", canEdit: true, stored: "local" };
  }
  if (!useDatabase) {
    return { scenarios: [...LIBRARY, ...local], meta, persistence: "local" };
  }
  try {
    const res = await fetch("/api/scenarios", { credentials: "include" });
    if (!res.ok) return { scenarios: [...LIBRARY, ...local], meta, persistence: "local" };
    const data = (await res.json()) as { scenarios?: ApiCustomScenarioRecord[]; persistence?: "database" | "local" };
    const dbItems = (Array.isArray(data.scenarios) ? data.scenarios : [])
      .map(parseApiRecord)
      .filter((x): x is { scenario: Scenario; meta: ScenarioMeta } => x !== null);
    const dbById = new Map<string, Scenario>();
    for (const item of dbItems) {
      dbById.set(item.scenario.id, item.scenario);
      meta[item.scenario.id] = item.meta;
    }
    // Keep any unsynced browser-only scenarios alongside server ones so nothing vanishes mid-migration.
    const localOnly = local.filter((s) => !dbById.has(s.id));
    return {
      scenarios: [...LIBRARY, ...dbItems.map((x) => x.scenario), ...localOnly],
      meta,
      persistence: data.persistence === "database" ? "database" : "local",
    };
  } catch {
    return { scenarios: [...LIBRARY, ...local], meta, persistence: "local" };
  }
}

/** Resolves one scenario by id, checking library + localStorage first and falling back to /api/scenarios/[id]. */
export async function fetchScenarioById(id: string, useDatabase: boolean): Promise<{ scenario: Scenario; meta?: ScenarioMeta } | null> {
  const builtin = LIBRARY.find((s) => s.id === id);
  if (builtin) return { scenario: builtin };
  if (useDatabase) {
    try {
      const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { item?: ApiCustomScenarioRecord };
        const parsed = data.item ? parseApiRecord(data.item) : null;
        if (parsed) return parsed;
      }
    } catch {
      /* fall through to localStorage */
    }
  }
  const local = loadCustomScenarios().find((s) => s.id === id);
  if (local) {
    return {
      scenario: local,
      meta: { sharedWithOrg: false, keepRealNames: true, sourceUrl: null, updatedAt: "", canEdit: true, stored: "local" },
    };
  }
  return null;
}

/**
 * Persists a custom persona to the user's account (/api/scenarios) when signed in with a database,
 * or to localStorage in demo mode. Throws a readable Error on validation, permission or 409 conflicts.
 */
export async function persistCustomScenario(args: {
  scenario: Scenario;
  useDatabase: boolean;
  sharedWithOrg?: boolean;
  keepRealNames?: boolean;
  sourceUrl?: string | null;
  expectedUpdatedAt?: string;
  isUpdate?: boolean;
}): Promise<{ scenario: Scenario; meta: ScenarioMeta }> {
  const clean: Scenario = { ...args.scenario, builtIn: false };
  if (!args.useDatabase) {
    saveCustomScenario(clean);
    return {
      scenario: clean,
      meta: {
        sharedWithOrg: false,
        keepRealNames: args.keepRealNames ?? true,
        sourceUrl: args.sourceUrl ?? null,
        updatedAt: new Date().toISOString(),
        canEdit: true,
        stored: "local",
      },
    };
  }

  const endpoint = args.isUpdate ? `/api/scenarios/${encodeURIComponent(clean.id)}` : "/api/scenarios";
  const method = args.isUpdate ? "PUT" : "POST";
  const res = await fetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      scenario: clean,
      ...(args.sharedWithOrg !== undefined ? { sharedWithOrg: args.sharedWithOrg } : {}),
      ...(args.keepRealNames !== undefined ? { keepRealNames: args.keepRealNames } : {}),
      ...(args.sourceUrl !== undefined ? { sourceUrl: args.sourceUrl } : {}),
      ...(args.expectedUpdatedAt ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}),
    }),
  });

  if (res.status === 503) {
    // Database unavailable: fall back gracefully to local browser storage.
    saveCustomScenario(clean);
    return {
      scenario: clean,
      meta: {
        sharedWithOrg: false,
        keepRealNames: args.keepRealNames ?? true,
        sourceUrl: args.sourceUrl ?? null,
        updatedAt: new Date().toISOString(),
        canEdit: true,
        stored: "local",
      },
    };
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || body.error || "Could not save this persona. Try again.");
  }

  const parsed = body.item ? parseApiRecord(body.item as ApiCustomScenarioRecord) : null;
  if (!parsed) throw new Error("Unexpected response when saving this persona.");
  // Remove any stale browser copy now that the server owns this id.
  deleteCustomScenario(parsed.scenario.id);
  return parsed;
}

/** Deletes a custom persona from the account (when stored in DB) and clears any local copy. */
export async function removeCustomScenario(id: string, useDatabase: boolean, stored?: "database" | "local"): Promise<void> {
  if (useDatabase && stored !== "local") {
    const res = await fetch(`/api/scenarios/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
    if (!res.ok && res.status !== 404 && res.status !== 503) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || "Could not delete this persona. Try again.");
    }
  }
  deleteCustomScenario(id);
}

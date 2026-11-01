import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCapabilities, voiceModelForCall } from "@/lib/serverConfig";
import { voiceModelFromCaps } from "@/lib/voiceModel";
import { textModelFor } from "@/lib/textModel";
import { jobRows, voiceEngines } from "@/components/settings/models";
import { usageSnapshotFromUsage } from "@/lib/billingUi";

const VARS = [
  "OPENAI_API_KEY", "OPENAI_REALTIME_API_KEY", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "REALTIME_MODEL", "REALTIME_MODEL_STANDARD",
  "LLM_MODEL_COACH", "LLM_MODEL_GRADE", "LLM_MODEL_PERSONA", "LLM_MODEL_WIZARD", "LLM_API_KEY_GRADE", "LLM_BASE_URL_GRADE", "DEMO_MODE", "ELEVENLABS_API_KEY",
];
beforeEach(() => {
  for (const k of VARS) vi.stubEnv(k, "");
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
});
afterEach(() => vi.unstubAllEnvs());

describe("capabilities report what runs", () => {
  it("names the premium and standard voice models and each text role", () => {
    vi.stubEnv("LLM_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("LLM_MODEL_COACH", "gpt-6-luna");
    const caps = getCapabilities();
    expect(caps.realtimeModel).toBe("gpt-realtime-2.1");
    expect(caps.realtimeModelStandard).toBe("gpt-realtime-2.1-mini");
    expect(caps.llmModels).toEqual({ coach: "gpt-6-luna", grade: "claude-sonnet-5-5", persona: "claude-sonnet-5-5", wizard: "claude-sonnet-5-5" });
  });

  it("lists only the roles that have a key", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(getCapabilities().llmModels).toEqual({});
    expect(getCapabilities().llm).toBe(false);
    vi.stubEnv("LLM_API_KEY_GRADE", "grade-key");
    vi.stubEnv("LLM_BASE_URL_GRADE", "https://api.anthropic.com/v1");
    vi.stubEnv("LLM_MODEL_GRADE", "claude-sonnet-5-5");
    const caps = getCapabilities();
    expect(caps.llmModels).toEqual({ grade: "claude-sonnet-5-5" });
    expect(caps.llm).toBe(true);
  });

  it("the engine decides the model: unknown or premium runs premium, standard runs standard", () => {
    const caps = getCapabilities();
    expect(voiceModelFromCaps(caps)).toBe("gpt-realtime-2.1");
    expect(voiceModelFromCaps(caps, "premium")).toBe("gpt-realtime-2.1");
    expect(voiceModelFromCaps(caps, "standard")).toBe("gpt-realtime-2.1-mini");
    // The briefing and the session route use the same names.
    for (const engine of [undefined, "premium", "standard"] as const) expect(voiceModelFromCaps(caps, engine)).toBe(voiceModelForCall(engine));
  });

  it("a usage answer carries the engine the next call will use", () => {
    const base = { metered: true, remaining: 3, minutesCap: 10 };
    expect(usageSnapshotFromUsage({ ...base, voiceEngine: "standard" })?.voiceEngine).toBe("standard");
    expect(usageSnapshotFromUsage({ ...base, voiceEngine: "premium" })?.voiceEngine).toBe("premium");
    expect(usageSnapshotFromUsage({ ...base, voiceEngine: "bogus" })).not.toHaveProperty("voiceEngine");
    expect(usageSnapshotFromUsage(base)).not.toHaveProperty("voiceEngine");
  });

  it("without a realtime key no voice model is reported", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const caps = getCapabilities();
    expect(caps).not.toHaveProperty("realtimeModel");
    expect(voiceModelFromCaps(caps)).toBeUndefined();
  });
});

describe("textModelFor judges each job by its own key", () => {
  it("with only the grader keyed, the coach and caller have no AI model but the grader does", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY_GRADE", "grade-key");
    vi.stubEnv("LLM_BASE_URL_GRADE", "https://api.anthropic.com/v1");
    vi.stubEnv("LLM_MODEL", "claude-sonnet-5-5");
    const caps = getCapabilities();
    expect(caps.llm).toBe(true);
    expect(textModelFor(caps, "coach")).toBeUndefined();
    expect(textModelFor(caps, "persona")).toBeUndefined();
    expect(textModelFor(caps, "wizard")).toBeUndefined();
    expect(textModelFor(caps, "grade")).toBe("claude-sonnet-5-5");
  });

  it("reads the older single-model payload and handles missing capabilities", () => {
    expect(textModelFor({ llm: true, model: "gpt-x" }, "coach")).toBe("gpt-x");
    expect(textModelFor({ llm: false, model: "gpt-x" }, "coach")).toBeUndefined();
    expect(textModelFor(null, "grade")).toBeUndefined();
  });
});

describe("the briefing and /settings/models read the same capabilities", () => {
  it("changing REALTIME_MODEL or REALTIME_MODEL_STANDARD changes both surfaces", () => {
    const surfaces = () => {
      const caps = getCapabilities();
      const row = voiceEngines(caps as unknown as Record<string, unknown>).find((v) => v.id === "realtime")!;
      return {
        briefingPremium: voiceModelFromCaps(caps, "premium"),
        briefingStandard: voiceModelFromCaps(caps, "standard"),
        settingsPremium: row.model,
        settingsStandard: row.standardModel,
      };
    };
    expect(surfaces()).toEqual({ briefingPremium: "gpt-realtime-2.1", briefingStandard: "gpt-realtime-2.1-mini", settingsPremium: "gpt-realtime-2.1", settingsStandard: "gpt-realtime-2.1-mini" });

    vi.stubEnv("REALTIME_MODEL", "premium-override");
    vi.stubEnv("REALTIME_MODEL_STANDARD", "standard-override");
    expect(surfaces()).toEqual({ briefingPremium: "premium-override", briefingStandard: "standard-override", settingsPremium: "premium-override", settingsStandard: "standard-override" });
  });

  it("the models page shows each text role's own model", () => {
    vi.stubEnv("LLM_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("LLM_MODEL_COACH", "gpt-6-luna");
    const rows = Object.fromEntries(jobRows(getCapabilities() as unknown as Record<string, unknown>).map((j) => [j.id, j.engine]));
    expect(rows).toEqual({ coach: "gpt-6-luna", grading: "claude-sonnet-5-5", wizard: "claude-sonnet-5-5", caller: "claude-sonnet-5-5" });
  });

  it("a role without a key shows its fallback instead of a model", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY_GRADE", "grade-key");
    vi.stubEnv("LLM_BASE_URL_GRADE", "https://api.anthropic.com/v1");
    const rows = Object.fromEntries(jobRows(getCapabilities() as unknown as Record<string, unknown>).map((j) => [j.id, { engine: j.engine, ai: j.ai }]));
    expect(rows.grading.ai).toBe(true);
    expect(rows.coach).toEqual({ engine: "Rules-based coach", ai: false });
  });

  it("still reads the older single-model capabilities shape", () => {
    expect(jobRows({ llm: true, model: "gpt-x" }).every((j) => j.ai && j.engine === "gpt-x")).toBe(true);
  });
});

describe("marketing copy names no models", () => {
  const root = path.resolve(__dirname, "..");
  const files = (p: string): string[] => {
    const abs = path.join(root, p);
    if (!statSync(abs, { throwIfNoEntry: false })) return [];
    if (statSync(abs).isFile()) return [abs];
    return readdirSync(abs, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.(tsx?|json|md)$/.test(e.name)).map((e) => path.join(e.parentPath, e.name));
  };

  it.each(["src/app/page.tsx", "src/components/landing", "src/app/pricing", "src/app/for"])("%s has no gpt- or claude- model id", (p) => {
    const found = files(p);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(readFileSync(f, "utf8"), path.relative(root, f)).not.toMatch(/gpt-|claude-/i);
  });
});

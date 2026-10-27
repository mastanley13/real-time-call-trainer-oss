import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generatePersona } from "@/lib/personaWizard";
import { CALL_TYPES, CALL_TYPE_LABELS, ScenarioSchema, jobFamilyLabel, talkTrackSteps, type Scenario } from "@/lib/scenarios";
import { scriptedReply } from "@/lib/scriptedCaller";
import { WizardInputSchema, type WizardInput, type WizardOutput } from "@/lib/wizard-types";

const SNIPPET_MAX = 140;
const FAMILIES = ["sdr", "ae", "cs", "home-services", "retail", "logistics", "general", "insurance", "mortgage", "financial", "medical", "collections"];
const REGULATED = ["insurance", "mortgage", "financial", "medical", "collections"];

const FREIGHT: WizardInput = {
  role: "sdr",
  industry: "Freight brokerage",
  callType: "cold",
  difficulty: "medium",
  product: "Our load-matching and carrier-vetting platform for mid-size brokerages. It cuts empty miles and flags risky carriers before a load is booked.",
  contexts: [
    {
      kind: "icp",
      text: "VP of Operations at freight brokerages with 50-300 employees. They run their own carrier network, fight thin margins and lose hours every week to manual load matching and carrier compliance checks. Usually on a legacy TMS and wary of new software.",
    },
    {
      kind: "crm",
      text: "Front desk said the VP prefers calls before 9am. The company added 40 trucks to its network in Q2 and posted about double-brokering fraud on LinkedIn last month.",
    },
  ],
};

const blank = (role: string, callType: WizardInput["callType"], difficulty: WizardInput["difficulty"] = "hard"): WizardInput => ({
  role,
  industry: "",
  callType,
  difficulty,
  product: "",
  contexts: [],
});

/** The chip text a "chips" source may quote: role, family label, industry, call type, difficulty and product. */
const chipsText = (input: WizardInput) =>
  [input.role, jobFamilyLabel(input.role), input.industry, input.callType, CALL_TYPE_LABELS[input.callType], input.difficulty, input.product].join("\n");

const weightTotal = (s: Scenario) => s.rubric.reduce((a, c) => a + c.weight, 0);
const hasCompliance = (s: Scenario) => s.rubric.some((c) => c.id === "compliance");

beforeAll(() => {
  // No key: generatePersona must take the template path.
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("generatePersona template path", () => {
  describe.each(CALL_TYPES.map((t) => [t]))("%s call", (callType) => {
    it.each(FAMILIES.map((f) => [f]))("builds a valid draft scenario for %s", async (role) => {
      const input = blank(role, callType);
      expect(WizardInputSchema.safeParse(input).success).toBe(true);
      const out = await generatePersona(input);
      const s = out.scenario;

      expect(out.method).toBe("template");
      expect(out.model).toBeUndefined();
      expect(ScenarioSchema.safeParse(s).success).toBe(true);
      expect(s).toMatchObject({ role, callType, difficulty: "hard", builtIn: false, status: "draft" });
      expect(s.id).toMatch(/^custom-[a-z0-9]+-[a-z0-9]{1,4}$/);

      expect(s.rubric.every((c) => Number.isInteger(c.weight) && c.weight > 0)).toBe(true);
      expect(weightTotal(s)).toBe(100);
      expect(new Set(s.rubric.map((c) => c.id)).size).toBe(s.rubric.length);

      const steps = talkTrackSteps(s.callScript);
      expect(steps.length).toBeGreaterThanOrEqual(5);
      expect(steps.length).toBeLessThanOrEqual(8);
      expect(s.objections.length).toBeGreaterThanOrEqual(1);
      expect(s.aiPersona.name).not.toBe("");
      expect(s.aiPersona.openingLine).not.toBe("");
      // The offline scripted caller needs a line with a phone number to answer contact questions.
      expect(s.sampleReplies.some((r) => /\d{3}[-. ]\d{4}/.test(r))).toBe(true);
    });
  });

  it.each(REGULATED.map((f) => [f]))("adds a compliance criterion for the regulated %s family on every call type", async (role) => {
    for (const callType of CALL_TYPES) {
      const { scenario } = await generatePersona(blank(role, callType));
      expect(hasCompliance(scenario)).toBe(true);
      expect(weightTotal(scenario)).toBe(100);
    }
  });

  it("adds a compliance criterion when the industry or product is regulated", async () => {
    const health = await generatePersona({ ...blank("sdr", "cold"), industry: "Health insurance" });
    const lending = await generatePersona({ ...blank("ae", "discovery"), product: "Small business loans for retailers" });
    expect(hasCompliance(health.scenario)).toBe(true);
    expect(hasCompliance(lending.scenario)).toBe(true);
  });

  it("adds a compliance criterion to any collections call, even in an unregulated family", async () => {
    const { scenario } = await generatePersona(blank("sdr", "collections"));
    expect(hasCompliance(scenario)).toBe(true);
    expect(weightTotal(scenario)).toBe(100);
  });

  it("does not add a compliance criterion for an unregulated field", async () => {
    const { scenario } = await generatePersona({ ...blank("home-services", "inbound"), industry: "Plumbing" });
    expect(hasCompliance(scenario)).toBe(false);
  });

  it("gives easy personas no more objections than hard ones", async () => {
    for (const callType of CALL_TYPES) {
      const easy = await generatePersona(blank("sdr", callType, "easy"));
      const hard = await generatePersona(blank("sdr", callType, "hard"));
      expect(easy.scenario.objections.length).toBeLessThanOrEqual(2);
      expect(easy.scenario.objections.length).toBeLessThanOrEqual(hard.scenario.objections.length);
    }
  });

  it("is deterministic for the same input apart from the id", async () => {
    const a = await generatePersona(FREIGHT);
    const b = await generatePersona(FREIGHT);
    expect({ ...a.scenario, id: "" }).toEqual({ ...b.scenario, id: "" });
    expect(a.sources).toEqual(b.sources);
  });
});

describe("generatePersona grounding", () => {
  let out: WizardOutput;
  beforeAll(async () => {
    out = await generatePersona(FREIGHT);
  });

  it("passes the schema and keeps the chips", () => {
    expect(ScenarioSchema.safeParse(out.scenario).success).toBe(true);
    expect(out.scenario).toMatchObject({ role: "sdr", industry: "Freight brokerage", callType: "cold", difficulty: "medium" });
  });

  it("takes the persona's job title from the ICP context", () => {
    expect(out.scenario.aiPersona.role).toMatch(/VP of Operations/);
    expect(out.sources["aiPersona.role"]).toEqual({ kind: "icp", snippet: "VP of Operations" });
  });

  it("quotes every source snippet verbatim from a context of the same kind, or from the chips", () => {
    const entries = Object.entries(out.sources);
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, src] of entries) {
      expect(src.snippet.length, path).toBeLessThanOrEqual(SNIPPET_MAX);
      expect(src.snippet.trim(), path).not.toBe("");
      if (src.kind === "chips") {
        expect(chipsText(FREIGHT), path).toContain(src.snippet);
      } else {
        const pool = FREIGHT.contexts.filter((c) => c.kind === src.kind).map((c) => c.text);
        expect(pool.some((t) => t.includes(src.snippet)), `${path}: "${src.snippet}"`).toBe(true);
      }
    }
  });

  it("weaves context sentences into the persona behavior", () => {
    expect(out.scenario.aiPersona.behavior).toContain("VP of Operations at freight brokerages with 50-300 employees.");
    expect(out.scenario.aiPersona.behavior).toContain("Front desk said the VP prefers calls before 9am.");
  });

  it("gives the offline scripted caller a phone number to answer with", () => {
    const s = out.scenario;
    const reply = scriptedReply(s, [
      { role: "assistant", text: s.aiPersona.openingLine },
      { role: "user", text: "What's the best number to reach you?" },
    ]);
    expect(reply).toMatch(/555-0137/);
  });
});

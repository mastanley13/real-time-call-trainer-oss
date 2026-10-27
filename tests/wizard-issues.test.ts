import { describe, expect, it } from "vitest";
import { ScenarioSchema } from "@/lib/scenarios";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { issueText } from "@/components/library/PersonaWizard";

const base = BUILT_IN_SCENARIOS[0];
const issuesOf = (draft: unknown) => {
  const r = ScenarioSchema.safeParse(draft);
  return r.success ? [] : r.error.issues.map(issueText);
};

describe("issueText", () => {
  it("names the field in plain words and says how to fix it", () => {
    expect(issuesOf({ ...base, aiPersona: { ...base.aiPersona, name: "" } })).toEqual(["Name: add the persona's name."]);
    expect(issuesOf({ ...base, title: "" })).toEqual(["Scenario title: add a title."]);
    expect(issuesOf({ ...base, objections: [{ type: "price", line: "", prepAnswer: "" }] })).toEqual(["Objection 1: add what the buyer says."]);
    expect(issuesOf({ ...base, aiPersona: { ...base.aiPersona, openingLine: "x".repeat(501) } })).toEqual(["Opening line: shorten it to 500 characters or fewer."]);
  });

  it("never shows zod's raw path or message", () => {
    for (const text of issuesOf({ ...base, title: "", rubric: [{ id: "", name: "", description: "", weight: 10 }] })) {
      expect(text).not.toMatch(/must contain|aiPersona\.|rubric\.\d/);
    }
  });
});

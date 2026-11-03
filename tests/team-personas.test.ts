import { describe, expect, it } from "vitest";
import { LIBRARY } from "@/lib/personas";
import { asTeamPersona, ImportSchema, isTeamPersonaId, knownLibraryIds, suggestForIndustries } from "@/lib/teamPersonas";

describe("team personas", () => {
  it("suggests only personas in the picked industries", () => {
    const picks = suggestForIndustries(LIBRARY, ["mortgage", "insurance"]);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((s) => s.role === "mortgage" || s.role === "insurance")).toBe(true);
    expect(suggestForIndustries(LIBRARY, [])).toEqual([]);
  });
  it("drops unknown and duplicate library ids", () => {
    const id = LIBRARY[0].id;
    expect(knownLibraryIds([id, "made-up", id], LIBRARY)).toEqual([id]);
  });
  it("only accepts real industry ids", () => {
    expect(ImportSchema.safeParse({ industries: ["mortgage"], libraryIds: [] }).success).toBe(true);
    expect(ImportSchema.safeParse({ industries: ["not-an-industry"], libraryIds: [] }).success).toBe(false);
  });
  it("stores a custom team persona as a draft with a team- id", () => {
    const s = asTeamPersona({ ...LIBRARY[0], status: "reviewed", builtIn: true }, "abc123");
    expect(s.id).toBe("team-abc123");
    expect(s.status).toBe("draft");
    expect(s.builtIn).toBe(false);
    expect(isTeamPersonaId(s.id)).toBe(true);
    expect(isTeamPersonaId(LIBRARY[0].id)).toBe(false);
  });
});

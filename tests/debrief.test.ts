import { describe, expect, it } from "vitest";
import { nextDrill, retryPoint } from "@/lib/debrief";
import type { Evaluation } from "@/lib/grader-types";
import { LIBRARY } from "@/lib/personas";
import { BUILT_IN_SCENARIOS, type ObjectionType, type Scenario } from "@/lib/scenarios";

const base = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;

const evaluation = (criteria: { id: string; name: string; score: number; line?: number }[]): Evaluation => ({
  method: "heuristic",
  overallScore: 50,
  grade: "F",
  summary: "",
  criteria: criteria.map((c) => ({ id: c.id, name: c.name, weight: 1, score: c.score, rationale: "", evidence: c.line ? [{ speaker: "trainee", quote: "x", line: c.line }] : [] })),
  strengths: [],
  improvements: [],
  goalAchievement: { achieved: false, explanation: "" },
});

describe("retryPoint", () => {
  const transcript = [
    { role: "assistant", text: "Hi, my water heater is leaking. Can someone come out today?" },
    { role: "user", text: "Thanks for calling, this is Sam. Our price is fair, don't worry." },
    { role: "assistant", text: "It started this morning." },
    { role: "user", text: "How old is the unit?" },
    { role: "assistant", text: "About eleven years. What does a visit cost?" },
    { role: "user", text: "We can come at 3 pm." },
    { role: "assistant", text: "Fine." },
  ];

  it("restarts at the persona line that raises the weakest topic", () => {
    const ev = evaluation([
      { id: "greeting", name: "Greeting & rapport", score: 90 },
      { id: "fee", name: "Pricing transparency", score: 30 },
      { id: "close", name: "Booking & next steps", score: 70 },
    ]);
    // The rep's own "price" line (T2) is skipped; the persona's cost question is T5.
    expect(retryPoint(transcript, ev)).toEqual({ turn: 5, criterion: "Pricing transparency", score: 30 });
  });

  it("never picks the opening line, and falls back to the persona line before the weakest evidence", () => {
    const opensOnPrice = [{ role: "assistant", text: "How much does a visit cost?" }, ...transcript.slice(1, 4)];
    const ev = evaluation([{ id: "fee", name: "Pricing transparency", score: 20, line: 4 }, { id: "greeting", name: "Greeting", score: 80 }]);
    expect(retryPoint(opensOnPrice, ev)?.turn).toBe(3);
  });

  it("returns null with nothing to retry", () => {
    expect(retryPoint(transcript, evaluation([]))).toBeNull();
    expect(retryPoint(transcript.slice(0, 1), evaluation([{ id: "fee", name: "Pricing", score: 10 }]))).toBeNull();
  });
});

describe("nextDrill", () => {
  const persona = (id: string, role: string, type: ObjectionType): Scenario => ({ ...base, id, role, objections: [{ type, line: "An objection.", prepAnswer: "" }] });

  it("drills the weakest topic's objection type with a different library persona", () => {
    const drill = nextDrill(LIBRARY, { id: base.id, role: base.role }, "Pricing transparency");
    expect(drill).toBeDefined();
    expect(drill!.id).not.toBe(base.id);
    expect(drill!.objections.some((o) => o.type === "price")).toBe(true);
    const sameRoleExists = LIBRARY.some((s) => s.id !== base.id && s.role === base.role && s.objections.some((o) => o.type === "price"));
    if (sameRoleExists) expect(drill!.role).toBe(base.role);
  });

  it("prefers a matching objection over a matching role", () => {
    const current = persona("current", "solar", "price");
    const lib = [current, persona("same-role-timing", "solar", "timing"), persona("other-role-price", "auto", "price")];
    expect(nextDrill(lib, current, "Pricing transparency")?.id).toBe("other-role-price");
    expect(nextDrill(lib, current, "Competitor comparison")?.id).toBe("same-role-timing");
  });

  it("never returns the current persona, even when it is the only match", () => {
    const current = persona("current", "solar", "price");
    expect(nextDrill([current, persona("x", "auto", "trust")], current, "Fee explanation")?.id).toBe("x");
    expect(nextDrill([current], current, "Fee explanation")).toBeUndefined();
  });
});

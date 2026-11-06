import { describe, expect, it } from "vitest";
import { anchorQuote, lacksEvidence, matchObjection, nextDrill, nextMove, plainRationale, retryHref, retryPoint, weakestCriterion } from "@/lib/debrief";
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

describe("retryHref", () => {
  it("builds the existing /trainer retry route, with the persona when known", () => {
    expect(retryHref("s-1", 5, "home-services-inbound-lead")).toBe("/trainer?retry=s-1&turn=5&scenario=home-services-inbound-lead");
    expect(retryHref("local-a b", 3)).toBe("/trainer?retry=local-a%20b&turn=3");
  });
});

describe("nextMove", () => {
  const transcript = [
    { role: "assistant", text: "Hi, my water heater is leaking. Can someone come out today?" },
    { role: "user", text: "Thanks for calling, this is Sam." },
    // The scripted caller says the pack's objection line verbatim.
    { role: "assistant", text: "About eleven years. What does a visit cost? Nobody mentioned a fee." },
    { role: "user", text: "We can come at 3 pm." },
    { role: "assistant", text: "Fine." },
  ];
  const withRationale = (ev: Evaluation, id: string, rationale: string): Evaluation => ({ ...ev, criteria: ev.criteria.map((c) => (c.id === id ? { ...c, rationale } : c)) });
  const ev = withRationale(evaluation([{ id: "rapport", name: "Greeting", score: 90 }, { id: "fee", name: "Pricing transparency", score: 30 }]), "fee", "You offered a slot before answering the cost question.");

  it("quotes the caller's exact words at the retry turn, the grader's rationale and the pack's prep answer", () => {
    const move = nextMove(transcript, ev, base)!;
    expect(move).toMatchObject({ criterionId: "fee", criterion: "Pricing transparency", score: 30, turn: 3, whatHappened: "You offered a slot before answering the cost question." });
    expect(move.buyerSaid).toBe(transcript[2].text);
    expect(move.turn).toBe(retryPoint(transcript, ev)!.turn);
    // The suggestion is the persona's own prep answer for the objection the buyer raised, never made up here.
    expect(move.trySaying).toBe(base.objections.find((o) => o.type === "price")!.prepAnswer);
  });

  it("omits what the data can't support instead of filling it in", () => {
    // No objection in the pack, the matching objection has an empty prep answer, or no pack at all: no suggestion.
    expect(nextMove(transcript, ev, { objections: [] })!.trySaying).toBeUndefined();
    expect(nextMove(transcript, ev, { objections: [{ type: "price", line: "What does a visit cost?", prepAnswer: "  " }] })!.trySaying).toBeUndefined();
    expect(nextMove(transcript, ev)!.trySaying).toBeUndefined();
    // A buyer line that matches none of the pack's objections gets no suggestion, even when the topic fits.
    const paraphrase = [...transcript.slice(0, 2), { role: "assistant", text: "About eleven years. What would the cost be?" }, ...transcript.slice(3)];
    expect(nextMove(paraphrase, ev, base)!.buyerSaid).toBe(paraphrase[2].text);
    expect(nextMove(paraphrase, ev, base)!.trySaying).toBeUndefined();
    // A caller line picked only as a fallback is not shown as "Buyer said", but the retry turn stays.
    const unrelated = evaluation([{ id: "x", name: "Empathy", score: 10 }]);
    const fallback = nextMove(transcript, unrelated)!;
    expect(fallback.turn).toBe(3);
    expect(fallback.buyerSaid).toBeUndefined();
    expect(fallback.whatHappened).toBeUndefined();
    // No criteria: no next move. No caller line: no turn and no quote.
    expect(nextMove(transcript, evaluation([]))).toBeNull();
    const noCaller = nextMove([{ role: "user", text: "Hello?" }, { role: "user", text: "Anyone?" }], ev)!;
    expect(noCaller.turn).toBeUndefined();
    expect(noCaller.buyerSaid).toBeUndefined();
  });

  it("kitchen remodel: a design-fee question gets the fee answer (stored as trust), not the price comparison", () => {
    const kitchen = LIBRARY.find((s) => s.id === "home-services-kitchen-remodel")!;
    const priceObj = kitchen.objections.find((o) => o.type === "price")!;
    const feeObj = kitchen.objections.find((o) => o.type === "trust")!;
    expect(feeObj.line).toMatch(/design fee/);
    const call = [
      { role: "assistant", text: kitchen.aiPersona.openingLine },
      { role: "user", text: "Thanks for calling. Tell me about the project." },
      { role: "assistant", text: priceObj.line },
      { role: "user", text: "There is a design fee to get started." },
      { role: "assistant", text: feeObj.line },
      { role: "user", text: "We can book you Saturday." },
    ];
    const grade: Evaluation = {
      ...evaluation(kitchen.rubric.map((c) => ({ id: c.id, name: c.name, score: c.id === "design_fee" ? 20 : 80 }))),
    };
    const move = nextMove(call, withRationale(grade, "design_fee", "You named the fee but not what it covers."), kitchen)!;
    expect(move.criterion).toBe("Explains the process and design fee");
    expect(move.turn).toBe(5);
    expect(move.buyerSaid).toBe(feeObj.line);
    expect(move.trySaying).toBe(feeObj.prepAnswer);
    expect(move.trySaying).not.toBe(priceObj.prepAnswer);
  });

  it("picks the same weakest criterion as the retry point, first one on a tie", () => {
    const tie = evaluation([{ id: "a", name: "Alpha", score: 20 }, { id: "b", name: "Beta", score: 20 }]);
    expect(weakestCriterion(tie)?.id).toBe("a");
    expect(nextMove(transcript, tie)!.criterionId).toBe("a");
  });

  it("rewrites legacy keyword rationales into a plain sentence", () => {
    expect(plainRationale("Keyword match: the trainee touched on 2 of 5 themes from this criterion (fee, cost).")).toBe("You addressed 2 of 5 expected points for this area.");
  });
});

describe("anchorQuote", () => {
  const transcript = [{ role: "assistant", text: "What does a visit cost?" }, { role: "user", text: "We charge a flat fee for the visit, and it goes toward the repair if you book." }];

  it("anchors an exact quote to its turn", () => {
    expect(anchorQuote(transcript, { quote: "a flat fee for the visit", line: 2 })).toEqual({ status: "exact", line: 2 });
  });

  it("accepts the rules-based grader's shortened excerpt", () => {
    expect(anchorQuote(transcript, { quote: "We charge a flat fee...", line: 2 })).toEqual({ status: "exact", line: 2 });
  });

  it("flags a cited turn whose wording differs, and a quote with no turn in this transcript", () => {
    expect(anchorQuote(transcript, { quote: "WE CHARGE A FLAT FEE", line: 2 })).toEqual({ status: "inexact", line: 2 });
    expect(anchorQuote(transcript, { quote: "a flat fee", line: 1 })).toEqual({ status: "inexact", line: 1 });
    expect(anchorQuote(transcript, { quote: "a flat fee" })).toEqual({ status: "unmatched" });
    expect(anchorQuote(transcript, { quote: "a flat fee", line: 9 })).toEqual({ status: "unmatched" });
    expect(anchorQuote(transcript, { quote: "a flat fee", line: 0 })).toEqual({ status: "unmatched" });
  });
});

describe("matchObjection", () => {
  const objections = [
    { type: "price" as const, line: "Why does the visit cost so much?", prepAnswer: "Price answer." },
    { type: "trust" as const, line: "Will a technician really show up today?", prepAnswer: "Trust answer." },
  ];

  it("matches the objection the buyer said, verbatim or nearly so", () => {
    expect(matchObjection("Okay. Why does the visit cost so much?", objections)?.prepAnswer).toBe("Price answer.");
    expect(matchObjection("Will your technician really show up today, honestly?", objections)?.prepAnswer).toBe("Trust answer.");
  });

  it("returns nothing for a loose paraphrase, an unrelated line, or a line that fits two objections", () => {
    expect(matchObjection("What would it cost?", objections)).toBeUndefined();
    expect(matchObjection("Sounds good, thanks.", objections)).toBeUndefined();
    expect(matchObjection("Why does the visit cost so much? Will a technician really show up today?", objections)).toBeUndefined();
    expect(matchObjection("Anything", [])).toBeUndefined();
  });
});

describe("lacksEvidence", () => {
  const transcript = [{ role: "assistant", text: "What does a visit cost?" }, { role: "user", text: "The visit is a flat fee." }];
  const withQuotes = (evidence: { quote: string; line?: number }[]): Evaluation => ({
    ...evaluation([{ id: "a", name: "A", score: 10 }]),
    criteria: [{ id: "a", name: "A", weight: 1, score: 10, rationale: "", evidence: evidence.map((e) => ({ speaker: "trainee" as const, ...e })) }],
  });

  it("is true when no criterion cites a quote", () => {
    expect(lacksEvidence(transcript, evaluation([{ id: "a", name: "A", score: 10 }]))).toBe(true);
  });

  it("counts only quotes that match their cited turn word for word", () => {
    expect(lacksEvidence(transcript, withQuotes([{ quote: "a flat fee", line: 2 }]))).toBe(false);
    // Wording differs from the cited turn, the cited turn isn't in this transcript, or no turn at all: not verified.
    expect(lacksEvidence(transcript, withQuotes([{ quote: "a FLAT fee", line: 2 }, { quote: "a flat fee", line: 7 }, { quote: "a flat fee" }]))).toBe(true);
    expect(lacksEvidence(transcript, withQuotes([{ quote: "a flat fee", line: 1 }, { quote: "a flat fee", line: 2 }]))).toBe(false);
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

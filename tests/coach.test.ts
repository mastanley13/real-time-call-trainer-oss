import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PROVISIONAL_MAX, coachHeuristic, coachTurn, type CoachTurnInput } from "@/lib/coach";
import { CueSchema, type CoachResult } from "@/lib/coach-types";
import { LIBRARY } from "@/lib/personas";
import { BUILT_IN_SCENARIOS, talkTrackSteps } from "@/lib/scenarios";

type Role = CoachTurnInput["role"];
const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const steps = talkTrackSteps(scenario.callScript);
const turns = (pairs: [Role, string][]): CoachTurnInput[] => pairs.map(([role, text]) => ({ role, text }));

// A good inbound call against the built-in water heater scenario. "user" is the rep, "assistant" the persona.
const CALL: [Role, string][] = [
  ["assistant", scenario.aiPersona.openingLine],
  ["user", "Thanks for calling Rapid Flow Plumbing, this is Sam. I'm sorry to hear that, let's get it sorted."],
  ["assistant", "Thanks. It's making a real mess out there."],
  ["user", "What's going on exactly, and how urgent is it? Is water still coming out right now?"],
  ["assistant", "It started this morning. There's a puddle by the base of the tank."],
  ["user", "Got it. How old is the unit, and where exactly is the leak coming from? Have you shut the water off?"],
  ["assistant", "I think it's about eleven years old. I haven't touched the water valve, should I?"],
  ["user", "Yes, turn the cold supply valve on top of the heater clockwise. Can I get your name, the service address and the best callback number?"],
  ["assistant", "Okay. My name is Dana Whitfield, 42 Maple Court. Number is 555-0142."],
  ["user", "Thanks Dana. I have a technician available this afternoon between 2 and 4. Does that window work?"],
  ["assistant", "What does a visit cost? Nobody mentioned a fee."],
  ["user", "Fair question. The diagnostic visit is $89, and it's credited toward the repair if you go ahead."],
  ["assistant", "Alright, that works. Can you confirm someone will really show up this afternoon?"],
  ["user", "Yes. To confirm, Dana Whitfield at 42 Maple Court, 555-0142, between 2 and 4 today. You'll get a text with the technician's name when they're on the way."],
  ["assistant", "Sounds good, thanks."],
];
/** 1-based transcript line of the persona's fee question. */
const FEE_LINE = CALL.findIndex(([, t]) => t.startsWith("What does a visit cost")) + 1;
/** 1-based lines of the rep's discovery questions. */
const URGENCY_LINE = 4;
const DIAGNOSTIC_LINE = 6;

const run = (pairs: [Role, string][], allowCue = true, recentCueKeys: string[] = []) =>
  coachHeuristic(scenario, turns(pairs), { allowCue, recentCueKeys });
const scoreOf = (r: CoachResult, id: string) => r.estimate.criteria.find((c) => c.id === id)!.score;

/** Replays CALL turn by turn through coachTurn, feeding cue keys back like the client does. */
let replay: CoachResult[] = [];

beforeAll(async () => {
  // No key: coachTurn must take the deterministic heuristic path.
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  const recent: string[] = [];
  const transcript: CoachTurnInput[] = [];
  replay = [];
  for (const [role, text] of CALL) {
    transcript.push({ role, text });
    const r = await coachTurn(scenario, [...transcript], { allowCue: true, recentCueKeys: [...recent] });
    if (r.cueKey) recent.push(r.cueKey);
    replay.push(r);
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const at = (line: number) => replay[line - 1];

describe("coachTurn without a key", () => {
  it("uses the heuristic coach", () => {
    expect(replay).toHaveLength(CALL.length);
    for (const r of replay) {
      expect(r.source).toBe("heuristic");
      expect(r.model).toBeUndefined();
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("raises the estimate as discovery questions are asked", () => {
    const greeted = at(2);
    expect(scoreOf(at(URGENCY_LINE), "discovery")).toBeGreaterThan(scoreOf(greeted, "discovery"));
    expect(scoreOf(at(DIAGNOSTIC_LINE), "discovery")).toBeGreaterThan(scoreOf(at(URGENCY_LINE), "discovery"));
    expect(at(DIAGNOSTIC_LINE).estimate.overall).toBeGreaterThan(greeted.estimate.overall);
    expect(replay[replay.length - 1].estimate.overall).toBeGreaterThan(at(DIAGNOSTIC_LINE).estimate.overall);
  });

  it("never drops the estimate by more than 5 points between turns", () => {
    replay.forEach((r, i) => {
      if (i > 0) expect(r.estimate.overall).toBeGreaterThanOrEqual(replay[i - 1].estimate.overall - 5);
    });
  });

  it("keeps criteria without a verbatim trainee quote provisional and capped", () => {
    const opening = at(1);
    expect(opening.estimate.overall).toBe(0);
    for (const c of opening.estimate.criteria) {
      expect(c.confirmed).toBe(false);
      expect(c.evidenceLine).toBeUndefined();
    }
    for (const r of replay) {
      for (const c of r.estimate.criteria) {
        if (c.confirmed) {
          // Evidence always points at one of the rep's own lines.
          expect(c.evidenceLine).toBeDefined();
          expect(CALL[c.evidenceLine! - 1][0]).toBe("user");
        } else {
          expect(c.evidenceLine).toBeUndefined();
          expect(c.score).toBeLessThanOrEqual(PROVISIONAL_MAX);
        }
      }
    }
    // The pricing criterion has no rep evidence until the fee is explained.
    const fee = at(FEE_LINE).estimate.criteria.find((c) => c.id === "fee")!;
    expect(fee.confirmed).toBe(false);
    expect(fee.score).toBeLessThanOrEqual(PROVISIONAL_MAX);
    const greeting = at(2).estimate.criteria.find((c) => c.id === "greeting")!;
    expect(greeting).toMatchObject({ confirmed: true, evidenceLine: 2 });
  });

  it("returns one weight per criterion summing to 100", () => {
    const { criteria } = at(2).estimate;
    expect(criteria.map((c) => c.id)).toEqual(scenario.rubric.map((c) => c.id));
    expect(criteria.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(100);
  });

  it("ticks talk-track steps as the rep covers them", () => {
    for (const r of replay) expect(r.steps).toHaveLength(steps.length);
    expect(at(1).steps.every((s) => !s)).toBe(true);
    expect(at(2).steps[0]).toBe(true);
    expect(at(URGENCY_LINE).steps[1]).toBe(true);
    expect(at(DIAGNOSTIC_LINE).steps[3]).toBe(true);
    // A ticked step stays ticked.
    replay.forEach((r, i) => {
      if (i === 0) return;
      r.steps.forEach((ticked, k) => {
        if (!ticked) expect(replay[i - 1].steps[k]).toBe(false);
      });
    });
    expect(replay[replay.length - 1].steps.every(Boolean)).toBe(true);
  });

  it("turns the persona's fee question into objection:price with the scenario's prep answer", () => {
    const priceObjection = scenario.objections.find((o) => o.type === "price")!;
    const r = at(FEE_LINE);
    expect(r.cueKey).toBe("objection:price");
    expect(r.cue).toMatchObject({ type: "objection", suggestedLine: priceObjection.prepAnswer, triggerTurn: FEE_LINE, criterionId: "fee" });
  });

  it("never repeats a cue key once it is in recentCueKeys", () => {
    const keys = replay.map((r) => r.cueKey).filter(Boolean);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns only cues that pass CueSchema", () => {
    for (const r of replay) {
      if (r.cue) expect(CueSchema.safeParse(r.cue).success).toBe(true);
      else expect(r.cueKey).toBeUndefined();
    }
  });

  it("reports the rep's share of words", () => {
    expect(at(1).talkRatio).toBe(0);
    for (const r of replay) {
      expect(r.talkRatio).toBeGreaterThanOrEqual(0);
      expect(r.talkRatio).toBeLessThanOrEqual(1);
    }
  });
});

describe("coachHeuristic cues", () => {
  it("gives no cue when allowCue is false, but still estimates and ticks steps", () => {
    for (let n = 1; n <= CALL.length; n++) {
      const guided = run(CALL.slice(0, n), false);
      const coached = run(CALL.slice(0, n), true);
      expect(guided.cue).toBeNull();
      expect(guided.cueKey).toBeUndefined();
      expect(guided.estimate).toEqual(coached.estimate);
      expect(guided.steps).toEqual(coached.steps);
    }
  });

  it("skips a cue whose key is in recentCueKeys", () => {
    const upToFee = CALL.slice(0, FEE_LINE);
    expect(run(upToFee).cueKey).toBe("objection:price");
    const repeat = run(upToFee, true, ["objection:price"]);
    expect(repeat.cueKey).not.toBe("objection:price");
    expect(repeat.cue?.type).not.toBe("objection");
  });

  it("drops the objection cue once the rep has answered it", () => {
    const answered = run(CALL.slice(0, FEE_LINE + 1));
    expect(answered.cueKey).not.toBe("objection:price");
  });

  it("flags stacked questions with a guardrail cue that suggests the first question", () => {
    const r = run([
      ["assistant", scenario.aiPersona.openingLine],
      ["user", "Okay. When did it start? How old is the heater? Is it gas or electric? Have you turned the water off?"],
    ]);
    expect(r.cueKey).toBe("guardrail:length");
    expect(r.cue).toMatchObject({ type: "guardrail", triggerTurn: 2, suggestedLine: "When did it start?" });
    expect(r.cue!.message).toMatch(/4 questions/);
  });

  it("flags a long rep turn with a guardrail cue", () => {
    const longTurn = Array.from({ length: 8 }, () => "We are licensed, insured and family owned with fast service.").join(" ");
    const r = run([
      ["assistant", scenario.aiPersona.openingLine],
      ["user", longTurn],
    ]);
    expect(r.cueKey).toBe("guardrail:length");
    expect(r.cue).toMatchObject({ type: "guardrail", title: "Keep it short", triggerTurn: 2 });
  });

  it("whispers when the rep does most of the talking", () => {
    const r = run([
      ["assistant", scenario.aiPersona.openingLine],
      [
        "user",
        "Sure. So we are a family-owned company and we have been doing this for more than twenty years across the whole county, and our technicians are all licensed and insured, and we carry most parts on the truck, so usually we can fix things in one visit, and we also do tank and tankless installs, financing, maintenance plans and a lot more besides that.",
      ],
      ["assistant", "Okay."],
      ["user", "Yeah, and we also do drain cleaning and water softeners."],
    ]);
    expect(r.talkRatio).toBeGreaterThan(0.7);
    expect(r.cueKey).toBe("whisper:ratio");
    expect(r.cue).toMatchObject({ type: "whisper", triggerTurn: 4 });
  });

  it("uses the 1-based position in the transcript as triggerTurn, even around blank turns", () => {
    const r = run([
      ["assistant", scenario.aiPersona.openingLine],
      ["user", ""],
      ["user", "Thanks for calling Rapid Flow Plumbing, this is Sam."],
      ["assistant", "  "],
      ["assistant", "What does a visit cost? Nobody mentioned a fee."],
    ]);
    expect(r.cueKey).toBe("objection:price");
    expect(r.cue?.triggerTurn).toBe(5);
  });

  it("handles an empty transcript", () => {
    const r = run([]);
    expect(r.estimate.overall).toBe(0);
    expect(r.cue).toBeNull();
    expect(r.cueKey).toBeUndefined();
    expect(r.talkRatio).toBe(0);
    expect(r.steps).toEqual(steps.map(() => false));
  });
});

describe("coach copy and step matching", () => {
  it("uses non-sales objection advice on collections calls", () => {
    const debt = { ...scenario, callType: "collections" as const };
    const priceLine = "What does a visit cost? Nobody mentioned a fee.";
    const sales = coachHeuristic(scenario, turns([["assistant", priceLine]]), { allowCue: true });
    const collections = coachHeuristic(debt, turns([["assistant", priceLine]]), { allowCue: true });
    expect(sales.cue?.title).toBe("Price objection: answer it directly");
    expect(collections.cueKey).toBe("objection:price");
    expect(collections.cue?.title).toBe("Can't pay: explore what is realistic");
    expect(collections.cue?.message).toMatch(/never threaten/);
  });

  it("does not treat 'feedback' in a step as a price topic", () => {
    const s = { ...scenario, callScript: "1. Ask for feedback on the showing" };
    const priceOnly = coachHeuristic(s, turns([["user", "The fee is $89."]]), { allowCue: false });
    const feedback = coachHeuristic(s, turns([["user", "What feedback did you get on the showing?"]]), { allowCue: false });
    expect(priceOnly.steps).toEqual([false]);
    expect(feedback.steps).toEqual([true]);
  });
});

describe("apology and acknowledgement steps", () => {
  // Ines Kovalenko, the angry COO: step 2 asks the rep to acknowledge the impact, step 3 to apologize once.
  const ines = LIBRARY.find((s) => s.id === "cs-angry-escalation-fulfillment-outage")!;
  const inesSteps = talkTrackSteps(ines.callScript);
  const ACK = inesSteps.findIndex((s) => /\backnowledge\b/i.test(s));
  const APOLOGY = inesSteps.findIndex((s) => /^apologize\b/i.test(s));
  const inesFlags = (pairs: [Role, string][]) => coachHeuristic(ines, turns([["assistant", ines.aiPersona.openingLine], ...pairs]), { allowCue: false }).steps;

  it("finds both steps in the Ines talk track", () => {
    expect(ACK).toBeGreaterThanOrEqual(0);
    expect(APOLOGY).toBeGreaterThanOrEqual(0);
  });

  it("ticks both steps in a realistic call where the rep apologizes and acknowledges the impact", () => {
    const flags = inesFlags([
      ["user", "Ines, I'm calling about Tuesday's outage, and I want to listen first. Tell me what happened on your side."],
      ["assistant", ines.sampleReplies[0]],
      ["user", "Six hours with orders stalled, twice in three weeks. I understand how frustrating that is, and I'm sorry. That's on us, no excuses."],
    ]);
    expect(flags[ACK]).toBe(true);
    expect(flags[APOLOGY]).toBe(true);
  });

  it.each([
    "I'm sorry. Six hours down with orders stalled is not acceptable.",
    "I am so sorry about Tuesday.",
    "I apologize for the outage.",
    "My apologies, that should never have happened.",
    "That's on us, no excuses.",
    "We let you down, and that miss was ours.",
    "I want to apologize for Tuesday. Six hours down is not acceptable.",
    "I'd like to apologize for what happened.",
    "Let me start by apologizing.",
    "Sorry this happened.",
    "I apologize for the wait, can you tell me which orders stalled?",
  ])("ticks both steps when the rep says %j", (line) => {
    const flags = inesFlags([["user", line]]);
    expect(flags[ACK]).toBe(true);
    expect(flags[APOLOGY]).toBe(true);
  });

  it.each([
    "I understand how frustrating that is.",
    "I can only imagine what that did to your week.",
    "That sounds incredibly stressful.",
    "I know how hard this week has been.",
    "You're right, that should not have taken six hours.",
    "You're right about the updates.",
  ])("ticks the acknowledgement but not the apology for %j", (line) => {
    const flags = inesFlags([["user", line]]);
    expect(flags[ACK]).toBe(true);
    expect(flags[APOLOGY]).toBe(false);
  });

  it.each([
    "I'm sorry, I didn't catch that last part.",
    "I'm sorry?",
    "I'm sorry, you said Tuesday?",
    "The first diagnostic visit, that's on us.",
    "Great, you're right around the corner from our shop.",
    "You're right on time, let's begin.",
    "I understand how the billing works, so let me walk you through it.",
    "I won't apologize for the maintenance window.",
  ])("ticks neither step for %j", (line) => {
    const flags = inesFlags([["user", line]]);
    expect(flags[ACK]).toBe(false);
    expect(flags[APOLOGY]).toBe(false);
  });

  it("does not tick a step that asks for more than an apology on the apology alone", () => {
    // Aiko's step 2: name the agency, apologize for the calls and explain the identity check.
    const aiko = LIBRARY.find((s) => s.id === "collections-disputed-debt")!;
    const step = talkTrackSteps(aiko.callScript).findIndex((s) => /apologize for the repeated calls/i.test(s));
    expect(step).toBeGreaterThanOrEqual(0);
    const aikoFlags = (line: string) => coachHeuristic(aiko, turns([["assistant", aiko.aiPersona.openingLine], ["user", line]]), { allowCue: false }).steps;
    expect(aikoFlags("I'm so sorry about all the calls.")[step]).toBe(false);
    expect(aikoFlags("This is Sam with Northvale Recovery Partners. I need to verify your identity before we talk about anything.")[step]).toBe(false);
    expect(
      aikoFlags("This is Sam with Northvale Recovery Partners. I'm sorry about all the calls. I need to verify your identity before we talk about anything.")[step],
    ).toBe(true);

    const custom = { ...scenario, callScript: "1. Apologize for the delay and give a firm arrival time for the technician." };
    expect(coachHeuristic(custom, turns([["user", "I'm so sorry about the delay."]]), { allowCue: false }).steps).toEqual([false]);
    const both = "I'm so sorry about the delay. The technician will arrive at 3 pm sharp.";
    expect(coachHeuristic(custom, turns([["user", both]]), { allowCue: false }).steps).toEqual([true]);
  });

  it.each([
    ["Present the price without discounting, hedging, or apologizing for it.", "The price is $500, and here is what it covers."],
    ["State the fee plainly; no need to apologize for it.", "The fee is $500, credited back to the project."],
    ["Instead of apologizing for the call, state the reason you are calling.", "I'm calling because I noticed you downloaded our guide."],
    ["Rather than apologize, thank her for her patience.", "Thank you for your patience, Maria."],
  ])("does not require an apology for the step %j", (step, line) => {
    const s = { ...scenario, callScript: `1. ${step}` };
    expect(coachHeuristic(s, turns([["user", line]]), { allowCue: false }).steps).toEqual([true]);
    expect(coachHeuristic(s, turns([["user", "I'm so sorry."]]), { allowCue: false }).steps).toEqual([false]);
  });

  it("still reads an apology after another instruction as an apology step", () => {
    const s = { ...scenario, callScript: "1. Don't interrupt, apologize sincerely." };
    expect(coachHeuristic(s, turns([["user", "Sorry about that."]]), { allowCue: false }).steps).toEqual([true]);
    expect(coachHeuristic(s, turns([["user", "Got it, go on."]]), { allowCue: false }).steps).toEqual([false]);
  });

  it("ticks neither step in a call without an apology or acknowledgement", () => {
    const flags = inesFlags([
      ["user", "Sorry, could you repeat that? I'm calling about Tuesday's outage."],
      ["assistant", ines.sampleReplies[0]],
      ["user", "When did it start, which orders and clients were affected, and what were you told?"],
      ["assistant", ines.sampleReplies[1]],
      ["user", "Can I get the order numbers? Please open a ticket with support and they will route it to an engineer."],
    ]);
    expect(flags[ACK]).toBe(false);
    expect(flags[APOLOGY]).toBe(false);
    // The fact-finding step still ticks, so the call is otherwise being read.
    expect(flags.some(Boolean)).toBe(true);
  });

  it("does not tick steps that only mention an apology in passing", () => {
    const s = {
      ...scenario,
      callScript: [
        "1. Present the proposal confidently, without apologizing for the scope.",
        "2. Explain that a written dispute sent within the validation period pauses collection.",
        "3. Ask whether the home is listed with another broker now; if he asks you to stop calling, apologize and end the call.",
      ].join("\n"),
    };
    const apologyOnly = coachHeuristic(s, turns([["user", "I'm so sorry, I understand how frustrating this is."]]), { allowCue: false });
    expect(apologyOnly.steps).toEqual([false, false, false]);
    // A conditional apology step is still judged on what it asks first.
    const askedListing = coachHeuristic(s, turns([["user", "Is the home listed with another broker right now?"]]), { allowCue: false });
    expect(askedListing.steps[2]).toBe(true);
  });
});

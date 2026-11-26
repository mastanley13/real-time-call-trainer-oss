/**
 * Scenario model shared by client and server.
 *
 * A scenario is plain data: a talk track for the trainee, an AI persona that
 * plays the other side of the call, the trainee's goal, and a weighted rubric
 * used for post-call grading. Built-ins are read-only; users duplicate them
 * to customize (see src/lib/scenarioStore.ts for persistence).
 */
import { z } from "zod";

export const RubricCriterionSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  description: z.string().max(600),
  weight: z.number().min(0).max(100),
});

/** Sales job families used to facet the persona library. Custom scenarios may use any string. */
export const JOB_FAMILIES = [
  { id: "sdr", label: "SDR cold calls" },
  { id: "ae", label: "AE discovery" },
  { id: "cs", label: "Customer success & renewals" },
  { id: "home-services", label: "Home services" },
  { id: "insurance", label: "Insurance" },
  { id: "mortgage", label: "Mortgage & lending" },
  { id: "real-estate", label: "Real estate" },
  { id: "solar", label: "Solar & energy" },
  { id: "auto", label: "Auto sales" },
  { id: "medical", label: "Medical devices" },
  { id: "procurement", label: "B2B procurement" },
  { id: "recruiting", label: "Recruiting" },
  { id: "retail", label: "Retail & consumer" },
  { id: "collections", label: "Collections" },
  { id: "financial", label: "Financial advising" },
  { id: "logistics", label: "Logistics & freight" },
  { id: "telecom", label: "Telecom & utilities" },
  { id: "general", label: "General sales" },
] as const;

export const CALL_TYPES = ["inbound", "cold", "discovery", "follow_up", "renewal", "negotiation", "collections", "service"] as const;
export const CALL_TYPE_LABELS: Record<(typeof CALL_TYPES)[number], string> = {
  inbound: "Inbound", cold: "Cold call", discovery: "Discovery", follow_up: "Follow-up",
  renewal: "Renewal", negotiation: "Negotiation", collections: "Collections", service: "Service",
};

export const OBJECTION_TYPES = ["price", "timing", "competitor", "authority", "trust", "status_quo", "need"] as const;
export const OBJECTION_LABELS: Record<(typeof OBJECTION_TYPES)[number], string> = {
  price: "Price", timing: "Timing", competitor: "Competitor", authority: "Authority",
  trust: "Trust", status_quo: "Status quo", need: "No need",
};

/** An objection the persona will raise, with a coachable prep answer (used by the live coach and the briefing). */
export const ObjectionSchema = z.object({
  type: z.enum(OBJECTION_TYPES),
  line: z.string().min(1).max(300),
  prepAnswer: z.string().max(400),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  industry: z.string().max(80),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  /** Job family id from JOB_FAMILIES (free text for custom scenarios). */
  role: z.string().max(40).default("general"),
  callType: z.enum(CALL_TYPES).default("inbound"),
  /** Typical call length in minutes, shown on library cards. */
  durationMin: z.number().min(1).max(60).default(6),
  callScript: z.string().max(6000),
  aiPersona: z.object({
    name: z.string().min(1).max(80),
    role: z.string().max(200),
    behavior: z.string().max(3000),
    openingLine: z.string().max(500),
    /** Optional ElevenLabs voice id override. */
    voiceId: z.string().max(80).optional(),
    /** Optional OpenAI Realtime voice name (e.g. "cedar"); unknown names fall back to REALTIME_VOICE. */
    realtimeVoice: z.string().max(40).optional(),
    /** Optional GPT-Live voice name (e.g. "willow"); used only when OPENAI_VOICE_API=live. Unknown names fall back. */
    liveVoice: z.string().max(40).optional(),
    /** Optional GPT-Live "Backchannel policy" text for this persona (src/lib/live.ts). */
    liveBackchannel: z.string().max(600).optional(),
    /** Optional GPT-Live "Interruption policy" text for this persona (src/lib/live.ts). */
    liveInterruption: z.string().max(600).optional(),
    /**
     * Optional GPT-Live delivery notes (pace, expressiveness, maturity, emotional tone) added to session.instructions
     * (src/lib/liveCasting.ts). The API has no age or style field, so this is natural-language direction. Optional, so
     * saved and wizard-made scenarios without it parse and run as before.
     */
    liveDelivery: z.string().max(400).optional(),
    /** The persona's gender, only when its own text states it (never inferred from a name). Used for GPT-Live casting. */
    gender: z.enum(["female", "male"]).optional(),
    /** The persona's age, only when its own text states it. */
    age: z.number().int().min(1).max(120).optional(),
    /** The persona's emotion at the start of the call ("worried", "guarded"...), for GPT-Live delivery. */
    emotion: z.string().max(20).optional(),
  }),
  traineeGoal: z.string().max(1000),
  rubric: z.array(RubricCriterionSchema).min(1).max(12),
  objections: z.array(ObjectionSchema).max(8).default([]),
  /** Scripted caller lines used by the offline text simulation (no LLM key). */
  sampleReplies: z.array(z.string().max(500)).max(20).default([]),
  /** Library personas start as drafts until a maintainer has reviewed them. */
  status: z.enum(["reviewed", "draft"]).default("reviewed"),
  builtIn: z.boolean().optional(),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Objection = z.infer<typeof ObjectionSchema>;
export type ObjectionType = (typeof OBJECTION_TYPES)[number];
export type CallType = (typeof CALL_TYPES)[number];

export const jobFamilyLabel = (id: string) => JOB_FAMILIES.find((f) => f.id === id)?.label ?? id;

/** Talk-track steps parsed from the numbered call script ("1. Greet ..." lines). */
export function talkTrackSteps(callScript: string): string[] {
  return callScript
    .split("\n")
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
}

export const BUILT_IN_SCENARIOS: Scenario[] = [
  {
    id: "home-services-inbound-lead",
    builtIn: true,
    title: "Inbound lead: leaking water heater",
    industry: "Home services",
    difficulty: "easy",
    role: "home-services",
    callType: "inbound",
    durationMin: 5,
    status: "reviewed",
    objections: [
      { type: "price", line: "What does a visit cost? Nobody mentioned a fee.", prepAnswer: "Fair question. The diagnostic visit is $89, and it's credited toward the repair if you go ahead." },
      { type: "trust", line: "Can you confirm someone will really show up this afternoon?", prepAnswer: "Yes. You'll get a text with the technician's name when they're on the way, and I'll call you if anything changes." },
    ],
    callScript: [
      "1. Greet warmly, give company name and your name.",
      "2. Ask what is going on and how urgent it is.",
      "3. Collect name, address, best callback number.",
      "4. Ask diagnostic questions (age of unit, where the leak is, water shut off?).",
      "5. Offer the next available appointment window and explain the diagnostic fee.",
      "6. Confirm details and set expectations for the technician's arrival.",
    ].join("\n"),
    aiPersona: {
      name: "Dana Whitfield",
      role: "Homeowner calling a plumbing company about a leaking water heater",
      behavior:
        "Worried but cooperative. You noticed water pooling around the heater this morning. The unit is about 11 years old. You have not shut the water off unless the agent tells you how. You will book if the agent is calm, asks good questions and gives a clear time window. You hesitate when asked about the fee until it is explained.",
      openingLine: "Hi, yeah, my water heater is leaking all over the garage floor. Can someone come out today?",
    },
    traineeGoal: "Book a same-day or next-day appointment and capture complete contact details.",
    rubric: [
      { id: "greeting", name: "Greeting & rapport", description: "Professional greeting, name and company, calm and friendly tone.", weight: 15 },
      { id: "discovery", name: "Discovery questions", description: "Asks about urgency, unit age, leak location and whether water is shut off.", weight: 30 },
      { id: "capture", name: "Information capture", description: "Gets name, address and callback number and confirms them.", weight: 20 },
      { id: "fee", name: "Pricing transparency", description: "Explains the diagnostic fee clearly before booking.", weight: 15 },
      { id: "close", name: "Booking & next steps", description: "Offers a specific window, books it and sets arrival expectations.", weight: 20 },
    ],
    sampleReplies: [
      "It started this morning. There's a puddle by the base of the tank.",
      "I think it's about eleven years old. I haven't touched the water valve, should I?",
      "Okay. My name is Dana Whitfield, 42 Maple Court. Number is 555-0142.",
      "What does a visit cost? Nobody mentioned a fee.",
      "Alright, that works. Can you confirm someone will really show up this afternoon?",
    ],
  },
  {
    id: "quote-follow-up",
    builtIn: true,
    title: "Quote follow-up: roof replacement",
    industry: "Home services",
    difficulty: "medium",
    role: "home-services",
    callType: "follow_up",
    durationMin: 7,
    status: "reviewed",
    objections: [
      { type: "authority", line: "Honestly I need to talk it over with my wife first.", prepAnswer: "That makes sense. What questions do you think she'll have? I'm happy to walk you both through it Thursday evening." },
      { type: "competitor", line: "I did get another number from someone else. They came in around twelve nine.", prepAnswer: "Thanks for telling me. Can we compare what's included? Our quote covers a 25-year material warranty and full tear-off." },
    ],
    callScript: [
      "1. Reference the quote sent last week and the prior visit.",
      "2. Ask open questions about what the customer thought of the proposal.",
      "3. Surface the real hold-up (price, timing, trust, spouse).",
      "4. Reinforce value: warranty, materials, crew quality.",
      "5. Propose a clear next step with a date (sign, site visit, financing call).",
    ].join("\n"),
    aiPersona: {
      name: "Marcus Bell",
      role: "Homeowner who received your $14,800 roof replacement quote last week and has gone quiet",
      behavior:
        "Polite but noncommittal. Last week the rep inspected your roof and emailed a $14,800 quote for a full roof replacement (full tear-off and 25-year material warranty). You liked the crew, but another contractor quoted $12,900 with a shorter 10-year warranty. You never volunteer the competing quote unless asked a calm, open question. You say you need to talk it over with your wife first. You respond well to curiosity and clear value comparisons on the warranty and tear-off, and poorly to pressure or immediate discounting.",
      openingLine: "Oh hey, yeah, I got the quote. I've just been really busy, honestly.",
    },
    traineeGoal: "Uncover the true objection and agree on a dated next step.",
    rubric: [
      { id: "opening", name: "Purposeful opening", description: "References the quote and visit and states the reason for the call.", weight: 15 },
      { id: "listening", name: "Open questions & listening", description: "Asks open questions and responds to what the customer actually says.", weight: 30 },
      { id: "objection", name: "Surfaces the real objection", description: "Uncovers the competing quote or spouse concern.", weight: 25 },
      { id: "value", name: "Value reinforcement", description: "Differentiates on warranty, materials or service instead of discounting immediately.", weight: 15 },
      { id: "nextstep", name: "Dated next step", description: "Ends with a specific, agreed next step and date.", weight: 15 },
    ],
    sampleReplies: [
      "Honestly I need to talk it over with my wife first.",
      "Well... it's a lot of money. I did get another number from someone else.",
      "They came in a bit lower, around twelve nine.",
      "I do like your crew though. What exactly does your warranty cover?",
      "Maybe Thursday evening we could look at it together.",
    ],
  },
  {
    id: "objection-handling",
    builtIn: true,
    title: "Objection handling: \"your price is too high\"",
    industry: "Sales (general)",
    difficulty: "hard",
    role: "general",
    callType: "negotiation",
    durationMin: 6,
    status: "reviewed",
    objections: [
      { type: "price", line: "This is twice what we pay now. I don't see how it's worth it.", prepAnswer: "I hear you. When you say twice, what are you comparing against, and what does that tool not do for your team today?" },
      { type: "timing", line: "A 24-month contract is a dealbreaker.", prepAnswer: "Understood. Would a month-to-month trial for the first quarter let you prove the value before committing?" },
    ],
    callScript: [
      "1. Acknowledge the objection without defending.",
      "2. Ask a clarifying question: too high compared to what?",
      "3. Reframe around outcome and total cost of ownership.",
      "4. Check whether the concern is resolved.",
      "5. Ask for the decision or a firm commitment.",
    ].join("\n"),
    aiPersona: {
      name: "Priya Raman",
      role: "Operations manager for a 35-person team reviewing your $1,200/month operations workflow software proposal",
      behavior:
        "Direct and time-pressed. You manage a 35-person operations team and just received the rep's $1,200/month proposal on a 24-month plan for an operations workflow and reporting platform. You open with a price objection and will interrupt vague pitches. Only when asked what you are comparing against do you share that you currently pay $600/month for a basic legacy tracking tool, though your team loses 8 to 10 hours a week to manual spreadsheet reconciliation and missed handoffs. You soften if the rep acknowledges the concern without getting defensive, asks what you are comparing against, and ties the $1,200/month price to concrete time savings and fewer errors. Once price is handled, you bring up a second objection: a 24-month contract is a dealbreaker. You agree to move forward if the rep proposes a 90-day month-to-month pilot or clear trial commitment with a specific start date.",
      openingLine: "I'll be straight with you: this is twice what we pay now. I don't see how it's worth it.",
    },
    traineeGoal: "Neutralize both objections and secure a trial start or commitment.",
    rubric: [
      { id: "acknowledge", name: "Acknowledges the objection", description: "Validates the concern without arguing or getting defensive.", weight: 20 },
      { id: "clarify", name: "Clarifies the comparison", description: "Asks what the price is being compared to and why it matters.", weight: 25 },
      { id: "reframe", name: "Reframes on outcomes", description: "Connects price to concrete outcome, ROI or total cost.", weight: 25 },
      { id: "second", name: "Handles the second objection", description: "Addresses the contract-length concern when it comes up.", weight: 15 },
      { id: "ask", name: "Asks for commitment", description: "Makes a clear ask for a trial, decision or next step.", weight: 15 },
    ],
    sampleReplies: [
      "We pay about half that for what we use today.",
      "Hm. Okay, what would we actually get for the extra money?",
      "Fine, but a 24-month contract is a dealbreaker.",
      "If there's a month-to-month trial, maybe.",
    ],
  },
];

export function newBlankScenario(): Scenario {
  return {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: "New scenario",
    industry: "",
    difficulty: "medium",
    role: "general",
    callType: "inbound",
    durationMin: 6,
    callScript: "",
    aiPersona: { name: "Caller", role: "", behavior: "", openingLine: "Hello?" },
    traineeGoal: "",
    rubric: [{ id: "c1", name: "Criterion 1", description: "", weight: 100 }],
    objections: [],
    sampleReplies: [],
    status: "reviewed",
  };
}

/** System prompt sent to the voice (and text) agent. Persona only: never coaches. */
export function buildAgentPrompt(s: Scenario): string {
  const p = s.aiPersona;
  return [
    `You are ${p.name}${p.role ? `, ${p.role}` : ""}. You are playing the other party in a live phone call so a trainee can practice.`,
    "",
    "RULES",
    "- Stay in role as this person for the whole call. Never break character.",
    "- Never coach, hint, evaluate or comment on the trainee's performance, and never mention that this is a simulation, a rubric or a training exercise.",
    "- Speak naturally in short spoken sentences (1-3 sentences per turn). No lists, no markdown, no stage directions.",
    "- Only reveal information when the trainee asks or when it would naturally come up. React realistically to good and poor technique.",
    "- If the trainee ends the call or the conversation reaches a natural conclusion, say a brief goodbye.",
    "",
    "YOUR BEHAVIOR",
    p.behavior || "Act like a typical person in this situation.",
    "",
    "CONTEXT (what the trainee is practicing, for your awareness only; never reveal it)",
    `Industry: ${s.industry || "general"}`,
    s.callScript ? `Expected talk track:\n${s.callScript}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function normalizeWeights(rubric: RubricCriterion[]): RubricCriterion[] {
  const total = rubric.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return rubric.map((c) => ({ ...c, weight: 100 / rubric.length }));
  return rubric.map((c) => ({ ...c, weight: (c.weight / total) * 100 }));
}

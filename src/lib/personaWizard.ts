import "server-only";
import { z } from "zod";
import { chatFull, extractJson } from "./llm";
import {
  CALL_TYPE_LABELS,
  OBJECTION_TYPES,
  ScenarioSchema,
  jobFamilyLabel,
  normalizeWeights,
  type CallType,
  type Objection,
  type ObjectionType,
  type RubricCriterion,
  type Scenario,
} from "./scenarios";
import { llmKey, llmModel } from "./serverConfig";
import { CONTEXT_LABELS, type FieldSource, type WizardInput, type WizardOutput } from "./wizard-types";

/**
 * AI persona wizard: turns chips (role, industry, call type, difficulty), a
 * product line and optional contexts (job description, product page, CRM notes,
 * ICP, pasted call) into a complete Scenario plus per-field provenance.
 *
 * Uses the configured LLM when available; otherwise (or on any LLM failure)
 * builds a complete scenario from templates so the wizard always works.
 */

const SNIPPET_MAX = 140;
const MAX_SOURCES = 40;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const newId = () => `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Truncate to n chars on a word boundary (with an ellipsis). */
function clip(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return `${(cut.replace(/\s+\S*$/, "") || cut).replace(/[,;:\s-]+$/, "")}…`;
}

/** Truncate to n chars on a word boundary without adding anything, so a verbatim excerpt stays verbatim. */
function clipVerbatim(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s-]+$/, "");
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

const firstSentence = (text: string, max = 200) => clipVerbatim(sentencesOf(text)[0] ?? "", max);
/** "Ideal customer" -> "ideal customer", but "CRM notes" stays as is. */
const lcFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function hashOf(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const REGULATED_FAMILIES = new Set(["insurance", "mortgage", "financial", "medical", "collections"]);
const REGULATED_RE = /\b(insur\w*|mortgage|loans?|lend\w*|financ\w*|invest\w*|annuit\w*|wealth|medical|health\w*|pharma\w*|clinic\w*|patient|hospital|collections?|debt|credit)\b/i;

function regulatedFamily(input: WizardInput): string | null {
  if (REGULATED_FAMILIES.has(input.role)) return input.role;
  // A collections call carries debt-collection disclosure rules whatever the rep's job family is.
  if (input.callType === "collections") return "collections";
  const m = REGULATED_RE.exec(`${input.industry} ${input.product}`);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (/insur|annuit/.test(w)) return "insurance";
  if (/mortgage|loan|lend/.test(w)) return "mortgage";
  if (/medical|health|pharma|clinic|patient|hospital/.test(w)) return "medical";
  if (/collection|debt/.test(w)) return "collections";
  return "financial";
}

const COMPLIANCE_TEXT: Record<string, string> = {
  insurance: "Gives required disclosures, describes coverage accurately, and never promises claim outcomes or pressures the customer.",
  mortgage: "Gives required disclosures, quotes rates and terms accurately, and never guarantees approval.",
  financial: "Checks suitability, gives required disclosures, and never guarantees returns or downplays risk.",
  medical: "Stays within approved claims, avoids off-label promotion, and protects patient information.",
  collections: "Gives the required disclosure, never threatens or misleads, and respects the customer's rights.",
};
const complianceCriterion = (family: string): RubricCriterion => ({
  id: "compliance",
  name: "Compliance & disclosures",
  description: COMPLIANCE_TEXT[family] ?? "Gives required disclosures and makes no misleading claims or guarantees.",
  weight: 15,
});
const hasCompliance = (rubric: RubricCriterion[]) => rubric.some((c) => /complian|disclos|regulat|consent/i.test(`${c.id} ${c.name} ${c.description}`));

/** Normalises weights to integers that sum to exactly 100 (largest remainder). */
function integerWeights(rubric: RubricCriterion[]): RubricCriterion[] {
  const n = normalizeWeights(rubric.map((c) => ({ ...c, weight: Math.max(0, Number.isFinite(c.weight) ? c.weight : 0) })));
  const floors = n.map((c) => Math.floor(c.weight));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = n.map((c, i) => ({ i, frac: c.weight - floors[i] })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return n.map((c, i) => ({ ...c, weight: floors[i] }));
}

function slugIds(rubric: RubricCriterion[]): RubricCriterion[] {
  const used = new Set<string>();
  return rubric.map((c, i) => {
    let id = (c.id || c.name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `c${i + 1}`;
    const base = id;
    for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
    used.add(id);
    return { ...c, id };
  });
}

/** Builds a numbered talk track ("1. ...") from lines, stripping any numbering the source already had. */
function numberedTrack(lines: string[]): string {
  return lines
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((l, i) => `${i + 1}. ${clip(l, 300)}`)
    .join("\n");
}

/**
 * The offline scripted caller (scriptedCaller.ts) picks sample replies by pattern,
 * so make sure there is a line for each intent it looks for.
 */
function ensureSampleReplies(replies: string[]): string[] {
  const out = replies.map((r) => clip(r, 500)).filter(Boolean).slice(0, 14);
  const need: [RegExp, string][] = [
    [/\d{3}[-. ]\d{4}/, "Sure, you can reach me at 555-0137."],
    [/\b(cost|price|fee|\$|expensive|pay|quote|afford)\b/i, "What would this cost, roughly?"],
    [/\b(today|tomorrow|afternoon|morning|works|schedule|show up|appointment|time)\b/i, "Later this week works better for my schedule."],
    [/\b(but|too|budget)\b/i, "I hear you, but the budget is tight right now."],
    [/\b(sounds good|thanks|thank you)\b/i, "Okay, sounds good. Thanks."],
  ];
  for (const [re, line] of need) if (!out.some((r) => re.test(r))) out.push(line);
  return out.slice(0, 20);
}

function chipsText(input: WizardInput): string {
  return [input.role, jobFamilyLabel(input.role), input.industry, input.callType, CALL_TYPE_LABELS[input.callType], input.difficulty, input.product].join("\n");
}

/**
 * Finds `snippet` in `text` allowing for case, whitespace and curly-quote
 * differences, and returns the excerpt exactly as it appears in `text`.
 */
function findVerbatim(text: string, snippet: string): string | null {
  const tokens = snippet
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
  if (!tokens.length || tokens.join(" ").length < 3) return null;
  const pattern = tokens.map((t) => esc(t).replace(/['‘’]/g, "['‘’]").replace(/["“”]/g, '["“”]')).join("\\s+");
  const m = new RegExp(pattern, "i").exec(text);
  return m ? m[0] : null;
}

/** Keeps only sources whose snippet really appears in the matching context (or the chips). */
function verifySources(raw: Record<string, unknown>, input: WizardInput): Record<string, FieldSource> {
  const pools: { kind: FieldSource["kind"]; text: string }[] = [
    ...input.contexts.filter((c) => c.text.trim()).map((c) => ({ kind: c.kind as FieldSource["kind"], text: c.text })),
    { kind: "chips", text: chipsText(input) },
  ];
  const out: Record<string, FieldSource> = {};
  for (const [path, v] of Object.entries(raw).slice(0, MAX_SOURCES * 2)) {
    if (Object.keys(out).length >= MAX_SOURCES) break;
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,59}$/.test(path) || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const kind = str(r.kind);
    if (kind === "model") {
      // Invented by the model: there is nothing in the context to point at.
      out[path] = { kind: "model", snippet: "" };
      continue;
    }
    const snippet = str(r.snippet);
    if (!snippet) continue;
    const ordered = [...pools.filter((p) => p.kind === kind), ...pools.filter((p) => p.kind !== kind)];
    for (const p of ordered) {
      const hit = findVerbatim(p.text, snippet);
      if (hit) {
        out[path] = { kind: p.kind, snippet: clipVerbatim(hit, SNIPPET_MAX) };
        break;
      }
    }
  }
  return out;
}

function finalize(candidate: Omit<Scenario, "id" | "builtIn" | "status">, family: string | null): Scenario {
  let rubric = candidate.rubric.slice(0, 11);
  if (family && !hasCompliance(rubric)) rubric = [...rubric, complianceCriterion(family)];
  rubric = integerWeights(slugIds(rubric));
  return ScenarioSchema.parse({
    ...candidate,
    id: newId(),
    builtIn: false,
    // AI-generated personas are unreviewed until the user (or a maintainer) checks them.
    status: "draft",
    rubric,
    sampleReplies: ensureSampleReplies(candidate.sampleReplies),
  });
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

const LlmScenario = z.object({
  title: z.string().default(""),
  industry: z.string().default(""),
  durationMin: z.coerce.number().catch(0),
  callScript: z.union([z.string(), z.array(z.string())]).default(""),
  aiPersona: z.object({
    name: z.string().min(1),
    role: z.string().default(""),
    behavior: z.string().min(1),
    openingLine: z.string().min(1),
  }),
  traineeGoal: z.string().default(""),
  rubric: z
    .array(z.object({ id: z.coerce.string().default(""), name: z.string().min(1), description: z.string().default(""), weight: z.coerce.number().catch(0) }))
    .min(1),
  objections: z.array(z.object({ type: z.string(), line: z.string(), prepAnswer: z.string().default("") })).default([]),
  sampleReplies: z.array(z.string()).default([]),
  sources: z.record(z.unknown()).catch({}).default({}),
});

const DIFFICULTY_GUIDE: Record<WizardInput["difficulty"], string> = {
  easy: "easy: cooperative and fairly open; raises one or two mild concerns.",
  medium: "medium: guarded at first; raises two objections; agrees only when the rep earns it.",
  hard: "hard: skeptical and short on time; interrupts vague pitches; stacks objections and raises a second one once the first is handled.",
};

function llmPrompt(input: WizardInput, family: string | null) {
  const system = [
    "You design realistic sales-call practice scenarios. A sales rep (the TRAINEE) will practise a live phone call against an AI persona you define, then be graded on your rubric.",
    "Ground every field in the CONTEXT provided. Only where the context is silent, invent plausible fictional details.",
    "Use fictional names for the persona and their company. Never use a real company's or real person's name, even if one appears in the context.",
    "Make the persona a specific individual with a job, constraints and motives. No stereotypes about any group (gender, age, ethnicity, nationality, religion, disability or accent).",
    family
      ? "This is a regulated field: include a rubric criterion for compliance (required disclosures, accurate claims, no guarantees, no pressure)."
      : "",
    "",
    "Respond with JSON only, matching this shape:",
    "{",
    '  "title": string (<= 80 chars),',
    '  "industry": string,',
    '  "durationMin": number (typical call length in minutes),',
    '  "callScript": string, 5-7 numbered lines "1. ...\\n2. ..." saying what the TRAINEE should do, in order,',
    '  "aiPersona": {',
    '    "name": string (fictional full name),',
    '    "role": string (job title and situation, <= 160 chars),',
    '    "behavior": string, 4-7 sentences in the second person ("You ..."): personality and situation; hidden information you reveal ONLY when the trainee asks a good question; the objections you raise; and exactly what earns your agreement,',
    '    "openingLine": string (the first thing you say when the call connects)',
    "  },",
    '  "traineeGoal": string (one sentence: the concrete outcome the trainee is after),',
    '  "rubric": [{"id": short_snake_case, "name": string, "description": concrete, observable trainee behaviour, "weight": number}] with 5-6 criteria whose weights sum to 100,',
    `  "objections": [{"type": one of ${OBJECTION_TYPES.map((t) => `"${t}"`).join("|")}, "line": what the persona says, "prepAnswer": a strong 1-2 sentence answer the trainee could give}] with 2-4 items,`,
    '  "sampleReplies": [string] with 6-8 short caller lines for an offline scripted caller. Include: one that gives a phone number like 555-0137; one asking about price or cost; one about timing or schedule; one pushback that uses "but", "too" or "budget"; and an agreeable close containing "sounds good" or "thanks",',
    '  "sources": {"<field path>": {"kind": "job"|"url"|"crm"|"icp"|"call"|"chips"|"model", "snippet": string}}',
    "}",
    'For "sources", use field paths such as "title", "industry", "aiPersona.name", "aiPersona.role", "aiPersona.behavior", "aiPersona.openingLine", "traineeGoal", "callScript", "rubric.0", "objections.1".',
    'Each snippet must be copied VERBATIM (a contiguous excerpt of at most 140 characters) from the context tab or chips that produced that field. Use kind "model" with an empty snippet for fields you invented.',
  ]
    .filter((l) => l !== "")
    .join("\n");

  const contexts = input.contexts.filter((c) => c.text.trim());
  const user = [
    "CHIPS",
    `Role (job family): ${input.role} (${jobFamilyLabel(input.role)})`,
    `Industry: ${input.industry || "(not given)"}`,
    `Call type: ${input.callType} (${CALL_TYPE_LABELS[input.callType]})`,
    `Difficulty: ${DIFFICULTY_GUIDE[input.difficulty]}`,
    `What the rep sells: ${input.product || "(not given)"}`,
    "",
    "CONTEXT",
    contexts.length
      ? contexts.map((c) => `--- [${c.kind}] ${CONTEXT_LABELS[c.kind]}${c.label ? `: ${c.label}` : ""} ---\n${c.text.trim()}`).join("\n\n")
      : "(none provided: build a typical, realistic scenario from the chips)",
  ].join("\n");
  return { system, user };
}

async function generateWithLlm(input: WizardInput): Promise<WizardOutput> {
  const family = regulatedFamily(input);
  const { system, user } = llmPrompt(input, family);
  const { text, truncated } = await chatFull(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, maxTokens: 3000, temperature: 0.7 },
  );
  if (truncated) throw new Error("LLM_TRUNCATED");
  const out = LlmScenario.parse(extractJson(text));

  const trackLines = Array.isArray(out.callScript) ? out.callScript : out.callScript.split("\n");
  const callScript = numberedTrack(trackLines);
  if (callScript.split("\n").length < 3) throw new Error("LLM_BAD_TALK_TRACK");

  const objections: Objection[] = out.objections
    .filter((o): o is { type: ObjectionType; line: string; prepAnswer: string } => (OBJECTION_TYPES as readonly string[]).includes(o.type) && o.line.trim().length > 0)
    .slice(0, 8)
    .map((o) => ({ type: o.type, line: clip(o.line, 300), prepAnswer: clip(o.prepAnswer, 400) }));

  const duration = Math.round(out.durationMin);
  const scenario = finalize(
    {
      title: clip(out.title || `${CALL_TYPE_LABELS[input.callType]}: ${out.aiPersona.name}`, 120),
      industry: clip(input.industry.trim() || out.industry, 80),
      difficulty: input.difficulty,
      role: input.role,
      callType: input.callType,
      durationMin: duration >= 1 && duration <= 60 ? duration : KITS[input.callType].duration,
      callScript,
      aiPersona: {
        name: clip(out.aiPersona.name, 80),
        role: clip(out.aiPersona.role, 200),
        behavior: clip(out.aiPersona.behavior, 3000),
        openingLine: clip(out.aiPersona.openingLine, 500),
      },
      traineeGoal: clip(out.traineeGoal || KITS[input.callType].goal, 1000),
      rubric: out.rubric.map((c) => ({ id: c.id, name: clip(c.name, 120), description: clip(c.description, 600), weight: c.weight })),
      objections,
      sampleReplies: out.sampleReplies,
    },
    family,
  );
  return { scenario, sources: verifySources(out.sources as Record<string, unknown>, input), method: "llm", model: llmModel() };
}

// ---------------------------------------------------------------------------
// Template path
// ---------------------------------------------------------------------------

interface Ctx {
  b2b: boolean;
  /** Rep's voice: "your load-matching platform". */
  repProduct: string;
  /** Neutral: "the load-matching platform". */
  theProduct: string;
  industry: string;
  company: string;
  title: string;
  first: string;
}

interface Kit {
  duration: number;
  goal: string;
  track: (c: Ctx) => string[];
  rubric: [string, string, string, number][];
  objections: ObjectionType[];
  situation: (c: Ctx) => string;
  agree: string;
  opening: (c: Ctx) => string;
}

const KITS: Record<CallType, Kit> = {
  cold: {
    duration: 4,
    goal: "Earn the conversation and book a short meeting with a specific day and time.",
    track: (c) => [
      "Greet them, introduce yourself and your company, and give a one-line reason for the call.",
      "Ask permission for a short conversation and give a reason for calling them specifically.",
      "Ask open questions about how they handle this today and what it costs them.",
      `Link ${c.repProduct} to the problem they describe in one or two sentences.`,
      "Handle the brush-off or objection calmly, without arguing.",
      "Propose a clear next step: a short meeting with a day and time.",
    ],
    rubric: [
      ["opening", "Opening & reason for calling", "Greets them, gives their name and company, and a clear reason for calling within the first two turns.", 20],
      ["relevance", "Earns the conversation", "Asks for a moment of their time and ties the call to something specific about their business, not a generic pitch.", 15],
      ["discovery", "Discovery questions", "Asks open questions about how they handle it today and what it costs them, and lets them answer.", 25],
      ["objection", "Handles the brush-off", "Acknowledges the objection, asks a question about it and keeps the conversation going without arguing.", 20],
      ["nextstep", "Books a next step", "Proposes a specific meeting with a day and time and confirms it.", 20],
    ],
    objections: ["timing", "status_quo", "authority"],
    situation: (c) =>
      c.b2b
        ? `You are the ${c.title} at ${c.company}, a ${c.industry.toLowerCase()} business, and you were not expecting this call.`
        : `You are at home and were not expecting a call about ${c.theProduct}.`,
    agree: "You agree to a 20-minute meeting only if the rep is relevant to your business, asks at least one sharp question and proposes a specific time.",
    opening: (c) => (c.b2b ? `${c.first} speaking. I've got about two minutes, what's this about?` : "Hello? Who's calling?"),
  },
  inbound: {
    duration: 5,
    goal: "Understand the need, explain the price clearly, and book the next step with complete contact details.",
    track: (c) => [
      "Greet them warmly with your name and company.",
      "Ask what prompted the call and how urgent it is.",
      "Collect their name, the best callback number and any address or account details.",
      "Ask questions to understand their situation before recommending anything.",
      `Recommend the right option for ${c.repProduct} and explain the price clearly.`,
      "Book the appointment or next step and confirm the details.",
    ],
    rubric: [
      ["greeting", "Greeting & rapport", "Professional greeting with name and company, calm and friendly tone.", 15],
      ["discovery", "Needs discovery", "Asks what prompted the call, how urgent it is and the key facts before recommending anything.", 25],
      ["capture", "Information capture", "Gets name, callback number and the details needed, and confirms them.", 20],
      ["pricing", "Pricing clarity", "Explains price or fees plainly when asked, including what they cover.", 15],
      ["close", "Booking & next steps", "Offers a specific option or time, books it and sets expectations.", 25],
    ],
    objections: ["price", "trust"],
    situation: (c) =>
      c.b2b
        ? `You are the ${c.title} at ${c.company} and you reached out because you are looking into ${c.theProduct}.`
        : `You called because you are interested in ${c.theProduct} but want to understand the cost and the process first.`,
    agree: "You book once the rep asks good questions, explains the price plainly and offers a specific time.",
    opening: (c) =>
      c.b2b
        ? `Hi, this is ${c.first} from ${c.company}. I filled out the form on your site and wanted to learn more.`
        : `Hi, I'm calling about ${c.repProduct}. I have a few questions before I decide anything.`,
  },
  discovery: {
    duration: 10,
    goal: "Uncover the current process, the cost of the problem and the decision process, and agree a dated next step.",
    track: (c) => [
      "Greet them, thank them for their time, and confirm the agenda and the time available.",
      "Ask about their current process and what prompted them to take the call.",
      "Dig into the impact: what the problem costs them in time, money or risk.",
      "Find out who else is involved in the decision and how they buy.",
      `Summarise what you heard and connect it to ${c.repProduct}.`,
      "Propose a clear next step with a date, such as a demo or a proposal review.",
    ],
    rubric: [
      ["agenda", "Agenda & framing", "Thanks them, confirms the time available and sets a clear agenda.", 15],
      ["current_state", "Current state", "Asks open questions about the current process and what prompted the call.", 25],
      ["impact", "Impact & pain", "Gets the prospect to put a cost on the problem in time, money or risk.", 20],
      ["decision", "Decision process", "Identifies other decision makers, the timeline and how they buy.", 15],
      ["nextstep", "Dated next step", "Summarises what they heard and agrees a specific next step with a date.", 25],
    ],
    objections: ["status_quo", "authority", "price"],
    situation: (c) =>
      `You agreed to this call because ${c.theProduct} might help ${c.b2b ? c.company : "you"}, but you have not committed to anything.`,
    agree: "You agree to a next step if the rep asks about impact and the decision process instead of pitching.",
    opening: (c) => `Hi, ${c.first} here. Thanks for setting this up. I've got about twenty minutes.`,
  },
  follow_up: {
    duration: 7,
    goal: "Uncover the real objection to the proposal and agree a dated next step.",
    track: (c) => [
      "Greet them and reference the proposal you sent and your last conversation.",
      "Ask open questions about what they thought of the proposal.",
      "Surface the real hold-up: price, timing, trust or another decision maker.",
      `Reinforce the value of ${c.repProduct} for their situation instead of discounting.`,
      "Propose a clear next step with a date.",
    ],
    rubric: [
      ["opening", "Purposeful opening", "References the proposal and the last conversation and states the reason for the call.", 15],
      ["listening", "Open questions & listening", "Asks open questions and responds to what the customer actually says.", 30],
      ["objection", "Surfaces the real objection", "Uncovers the true hold-up (price, timing, trust or another decision maker).", 25],
      ["value", "Value reinforcement", "Differentiates on value instead of discounting immediately.", 15],
      ["nextstep", "Dated next step", "Ends with a specific, agreed next step and date.", 15],
    ],
    objections: ["competitor", "authority"],
    situation: (c) => `You received a proposal for ${c.theProduct} last week and have gone quiet since.`,
    agree: "You commit to a dated next step if the rep is curious rather than pushy and addresses your real concern.",
    opening: () => "Oh, hi. Yeah, I got the proposal. I've just been really busy, honestly.",
  },
  renewal: {
    duration: 8,
    goal: "Surface any renewal risk, reinforce the value delivered, and secure the renewal or a dated next step.",
    track: (c) => [
      "Greet them and thank them for being a customer.",
      "Ask how things are going and what results they have seen.",
      "Surface any frustrations or reasons they might not renew.",
      `Reinforce the value ${c.repProduct} has delivered, with specifics, and address the concerns.`,
      "Discuss the renewal terms and handle price pushback.",
      "Ask for the renewal decision or a dated next step.",
    ],
    rubric: [
      ["rapport", "Rapport & appreciation", "Thanks them for their business and opens warmly.", 10],
      ["health", "Account health questions", "Asks how things are going and what results they have seen.", 25],
      ["risk", "Surfaces renewal risk", "Uncovers frustrations or reasons they might not renew.", 20],
      ["value", "Value with specifics", "Reinforces value with concrete results, not generic claims.", 20],
      ["commit", "Renewal commitment", "Handles price pushback and asks for the renewal or a dated next step.", 25],
    ],
    objections: ["price", "competitor"],
    situation: (c) => `Your contract for ${c.theProduct} renews next month and you have mixed feelings about it.`,
    agree: "You renew if the rep acknowledges your frustration and shows concrete value.",
    opening: () => "Hi. Yeah, I saw the renewal notice come through.",
  },
  negotiation: {
    duration: 8,
    goal: "Hold value on price, trade any concession for a commitment, and get a decision or a firm next step.",
    track: () => [
      "Greet them and acknowledge where the deal stands.",
      "Ask what matters most to them in the final terms.",
      "Acknowledge the price concern without getting defensive.",
      "Ask a clarifying question: too high compared to what?",
      "Trade any concession for a commitment instead of discounting outright.",
      "Ask for the decision or a firm commitment.",
    ],
    rubric: [
      ["acknowledge", "Acknowledges the concern", "Validates the price concern without arguing or getting defensive.", 20],
      ["clarify", "Clarifies the comparison", "Asks what the price is being compared to and what matters most.", 20],
      ["reframe", "Reframes on outcomes", "Connects price to concrete outcomes, ROI or total cost.", 25],
      ["trade", "Trades, doesn't cave", "Exchanges any concession for a commitment instead of discounting outright.", 15],
      ["ask", "Asks for commitment", "Makes a clear ask for the decision or a firm next step.", 20],
    ],
    objections: ["price", "timing"],
    situation: (c) => `You like ${c.theProduct}, but the price you were quoted is higher than you hoped.`,
    agree: "You move forward if the rep holds value and trades any concession for something in return.",
    opening: () => "I'll be honest, the number you sent over is higher than we expected.",
  },
  collections: {
    duration: 6,
    goal: "Agree a realistic, specific payment plan while staying respectful and compliant.",
    track: () => [
      "Greet them, identify yourself and your company, and confirm you are speaking with the right person.",
      "Give the required disclosure, then state the reason for the call and the balance clearly and respectfully.",
      "Ask questions to understand their situation and what they can afford.",
      "Offer realistic payment options.",
      "Agree a specific payment plan with amounts and dates.",
      "Confirm the arrangement and the next steps.",
    ],
    rubric: [
      ["identity", "Right party & identification", "Identifies themselves and the company and confirms they are speaking to the right person before discussing the account.", 15],
      ["respect", "Respectful tone", "Stays calm, respectful and non-judgemental, with no threats or pressure.", 20],
      ["situation", "Understands the situation", "Asks about the customer's circumstances and ability to pay.", 20],
      ["options", "Payment options", "Offers realistic options and explains them clearly.", 20],
      ["plan", "Agreed plan", "Agrees a specific plan with amounts and dates and confirms it.", 25],
    ],
    objections: ["price", "trust"],
    situation: (c) => `You are behind on a payment for ${c.theProduct} after a tough couple of months, and you feel a bit embarrassed and defensive about it.`,
    agree: "You agree to a payment plan if the rep is respectful and offers options you can actually afford.",
    opening: () => "Hello? Who's calling?",
  },
  service: {
    duration: 5,
    goal: "Resolve the issue or agree a clear fix, and leave the customer confident about what happens next.",
    track: () => [
      "Greet them with your name and company and thank them for calling.",
      "Ask what happened and acknowledge the frustration.",
      "Verify their account details.",
      "Ask questions to pin down the cause of the problem.",
      "Explain the fix or the options and what it will cost, if anything.",
      "Confirm the resolution and set expectations for what happens next.",
    ],
    rubric: [
      ["greeting", "Greeting & empathy", "Greets professionally and acknowledges the customer's frustration.", 20],
      ["verify", "Verification", "Verifies the account details before making changes.", 15],
      ["diagnose", "Diagnosis questions", "Asks focused questions to pin down the cause of the problem.", 25],
      ["resolution", "Clear resolution", "Explains the fix or options, including any cost, in plain language.", 20],
      ["expectations", "Next steps & expectations", "Confirms the resolution and sets clear expectations for what happens next.", 20],
    ],
    objections: ["price", "trust"],
    situation: (c) => `Something has gone wrong with ${c.theProduct} and you are frustrated about it.`,
    agree: "You calm down once the rep acknowledges the problem and gives a clear fix with a timeline.",
    opening: (c) => `Hi, I've got a problem with ${c.repProduct} and I'd like it sorted out today.`,
  },
};

/** Objection lines and prep answers per type, for business buyers and for consumers. */
const OBJECTION_LIB: Record<ObjectionType, { b2b: [string, string]; consumer: [string, string] }> = {
  price: {
    b2b: ["We don't have budget for another tool this year.", "That's fair. Most teams weigh it against what the problem costs them today. Roughly what is that costing you now?"],
    consumer: ["Honestly, that sounds expensive. What's this going to cost me?", "Fair question. I'll give you the exact price and what's included, and you can decide from there."],
  },
  timing: {
    b2b: ["I'm slammed right now. Can you just send me an email?", "Happy to. So I send something useful, what's the biggest headache on your plate this quarter?"],
    consumer: ["I'm not sure now is the right time for this.", "Understood. What would need to change for the timing to feel right?"],
  },
  competitor: {
    b2b: ["We already work with someone for this.", "Makes sense. What do you like about them, and is there anything you wish they did better?"],
    consumer: ["I got another quote that was cheaper.", "Thanks for telling me. Can we compare what's included side by side, so you're comparing like for like?"],
  },
  authority: {
    b2b: ["I'm not the one who signs off on this.", "Thanks for being upfront. Who else would weigh in, and what would they need to see?"],
    consumer: ["I'd need to talk it over with my partner first.", "That makes sense. What questions do you think they'll have? I'm happy to walk you both through it."],
  },
  trust: {
    b2b: ["How do I know this will actually work for a team like ours?", "Fair question. We can start small with one team, so you see results before you commit to more."],
    consumer: ["How do I know I can trust you on this?", "Completely fair. I'll put everything in writing, and you can check our reviews before you decide."],
  },
  status_quo: {
    b2b: ["What we have works fine for now.", "Glad it's working. If you could change one thing about how you handle it today, what would it be?"],
    consumer: ["I'm fine with how things are, to be honest.", "That's good to hear. What made you open to talking about it today?"],
  },
  need: {
    b2b: ["I don't think we need this.", "Understood. Out of curiosity, how are you handling it today?"],
    consumer: ["I don't really think I need this.", "No problem. Can I ask what you're doing about it at the moment?"],
  },
};

const COLLECTIONS_OBJECTIONS: Partial<Record<ObjectionType, [string, string]>> = {
  price: ["I just don't have the money right now. I can't pay the whole thing.", "I understand. Let's look at what you can manage. Would a smaller monthly amount on a set date work for you?"],
  trust: ["How do I know this call is even legitimate?", "Good question to ask. You can call us back on the number printed on your statement, and I can send the details in writing."],
};

const B2B_FAMILIES = new Set(["sdr", "ae", "cs", "procurement", "logistics", "recruiting", "telecom", "medical", "general"]);
const FAMILY_INDUSTRY: Record<string, string> = {
  sdr: "B2B software", ae: "B2B software", cs: "B2B software", "home-services": "Home services", insurance: "Insurance",
  mortgage: "Mortgage & lending", "real-estate": "Real estate", solar: "Solar & energy", auto: "Auto sales", medical: "Medical devices",
  procurement: "B2B procurement", recruiting: "Recruiting", retail: "Retail", collections: "Collections", financial: "Financial advising",
  logistics: "Logistics & freight", telecom: "Telecom & utilities", general: "General sales",
};
const CONSUMER_TITLES: Record<string, string> = {
  "home-services": "Homeowner", insurance: "Policyholder shopping for coverage", mortgage: "First-time home buyer",
  "real-estate": "Homeowner thinking about selling", solar: "Homeowner", auto: "Car shopper", retail: "Customer",
  collections: "Customer with an overdue balance", financial: "Pre-retiree reviewing their savings",
};
const PERSONA_NAMES = [
  "Jordan Avery", "Priya Natarajan", "Marcus Ellison", "Sofia Delgado", "Daniel Okafor", "Hannah Lindqvist",
  "Wei Lin", "Aisha Rahman", "Tomás Herrera", "Grace Whitaker", "Ravi Menon", "Elena Marsh",
];
const COMPANY_PREFIXES = ["Ridgeway", "Cobalt Creek", "Larkspur", "Granite Bay", "Tidewater", "Copperleaf", "Silver Fern", "Kestrel Point"];
const TITLE_RE = /\b((?:Senior |Sr\.? )?(?:VP|SVP|EVP|Vice President|Director|Head|Manager|Chief [A-Z][a-z]+ Officer|C[EFOTIR]O|Owner|Founder|Co-founder|President|Partner)(?: of [A-Z][\w&-]*(?: (?:&|and|[A-Z][\w&-]*))*)?)\b/;
const PAIN_RE = /\b(lose|losing|lost|waste|wasting|struggl\w*|problem|pain|frustrat\w*|manual\w*|slow|expensive|risk\w*|fight\w*|complain\w*|behind|churn\w*|miss\w*|delay\w*|error\w*|fraud\w*|thin margins?)\b/i;

function companySuffix(industry: string, role: string): string {
  const s = `${industry} ${role}`.toLowerCase();
  if (/freight|logistic|truck|shipping|broker/.test(s)) return "Freight";
  if (/software|saas|tech|sdr|ae\b/.test(s)) return "Systems";
  if (/medical|health|clinic|hospital/.test(s)) return "Health";
  if (/recruit|staffing/.test(s)) return "Staffing";
  if (/telecom|utilit/.test(s)) return "Networks";
  if (/manufactur|industrial/.test(s)) return "Manufacturing";
  return "Group";
}

/** Product phrases for the rep's voice and a neutral voice, from the first clause of the product line. */
function productPhrases(product: string, industry: string): { repProduct: string; theProduct: string; bare: string } {
  const first = (product.trim().split(/(?<=[.!?])\s+|\n|;|\s[-–—]\s/)[0] ?? "").replace(/[.!?,;:\s]+$/, "");
  const raw = clipVerbatim(first, 80);
  if (!raw) {
    const generic = `${industry.toLowerCase()} services`;
    return { repProduct: `our ${generic}`, theProduct: `the ${generic}`, bare: generic };
  }
  const m = /^(our|my|your|the|a|an)\s+/i.exec(raw);
  if (!m) return { repProduct: raw, theProduct: raw, bare: raw };
  const bare = raw.slice(m[0].length);
  return { repProduct: `your ${bare}`, theProduct: `the ${bare}`, bare };
}

/** Template scenario built from the chips, the product line and the first sentences of each context. */
export function templatePersona(input: WizardInput): WizardOutput {
  const kit = KITS[input.callType];
  const family = regulatedFamily(input);
  const b2b = B2B_FAMILIES.has(input.role) || !CONSUMER_TITLES[input.role];
  const industry = clip(input.industry.trim() || FAMILY_INDUSTRY[input.role] || jobFamilyLabel(input.role), 80);
  const seed = hashOf(JSON.stringify(input));
  const name = PERSONA_NAMES[seed % PERSONA_NAMES.length];
  const company = `${COMPANY_PREFIXES[(seed >>> 4) % COMPANY_PREFIXES.length]} ${companySuffix(industry, input.role)}`;
  const contexts = input.contexts.filter((c) => c.text.trim());
  const sources: Record<string, FieldSource> = {};
  const chip = (path: string, snippet: string) => {
    if (snippet.trim()) sources[path] = { kind: "chips", snippet: clipVerbatim(snippet, SNIPPET_MAX) };
  };

  // Persona title: a job title found in the ICP / CRM / job / call context, else a default for the family.
  let title = b2b ? "Head of Operations" : CONSUMER_TITLES[input.role] ?? "Customer";
  const titleCtx = [...contexts].sort((a, b) => ["icp", "crm", "call", "job", "url"].indexOf(a.kind) - ["icp", "crm", "call", "job", "url"].indexOf(b.kind));
  for (const c of b2b ? titleCtx : []) {
    const m = TITLE_RE.exec(c.text);
    if (m) {
      title = m[1].replace(/\s+(and|&)$/, "");
      sources["aiPersona.role"] = { kind: c.kind, snippet: clipVerbatim(title, SNIPPET_MAX) };
      break;
    }
  }
  if (!sources["aiPersona.role"]) chip("aiPersona.role", input.role);

  const { repProduct, theProduct } = productPhrases(input.product, industry);
  const ctx: Ctx = { b2b, repProduct, theProduct, industry, company, title, first: name.split(" ")[0] };

  // Objections for this call type; easy personas raise fewer.
  const types = kit.objections.slice(0, input.difficulty === "easy" ? 2 : 3);
  const objections: Objection[] = types.map((type) => {
    const [line, prepAnswer] = (input.callType === "collections" ? COLLECTIONS_OBJECTIONS[type] : undefined) ?? OBJECTION_LIB[type][b2b ? "b2b" : "consumer"];
    return { type, line, prepAnswer };
  });
  objections.forEach((_, i) => chip(`objections.${i}`, CALL_TYPE_LABELS[input.callType]));

  // Behavior: situation, grounded background, hidden detail, difficulty, objections, what earns agreement.
  const behavior: string[] = [kit.situation(ctx)];
  const firsts = contexts.slice(0, 3).map((c) => ({ kind: c.kind, s: firstSentence(c.text) })).filter((x) => x.s);
  for (const { kind, s } of firsts) {
    behavior.push(`From the rep's ${lcFirst(CONTEXT_LABELS[kind])} (true for you): ${s.replace(/[.!?]*$/, ".")}`);
  }
  if (firsts.length) sources["aiPersona.behavior"] = { kind: firsts[0].kind, snippet: clipVerbatim(firsts[0].s, SNIPPET_MAX) };
  else chip("aiPersona.behavior", input.product || CALL_TYPE_LABELS[input.callType]);
  const used = new Set(firsts.map((x) => x.s));
  const painSource = contexts.flatMap((c) => sentencesOf(c.text).map((s) => ({ kind: c.kind, s }))).find((x) => !used.has(clipVerbatim(x.s, 200)) && PAIN_RE.test(x.s));
  if (painSource) {
    const pain = clipVerbatim(painSource.s, 220);
    behavior.push(`Hidden detail you only reveal when the rep asks a good, specific question about how things work today: ${pain.replace(/[.!?]*$/, ".")}`);
    sources["aiPersona.behavior"] ??= { kind: painSource.kind, snippet: clipVerbatim(pain, SNIPPET_MAX) };
  } else {
    behavior.push("You have a real, specific frustration with how this is handled today, and you only share it when the rep asks a good open question.");
  }
  behavior.push(
    {
      easy: "You are fairly open and cooperative and answer questions directly.",
      medium: "You are guarded at first and give short answers until the rep earns your trust.",
      hard: "You are skeptical and short on time, interrupt vague or scripted pitches, and raise a second objection once the first is handled.",
    }[input.difficulty],
  );
  behavior.push(`Along the way you push back, for example: ${objections.map((o) => `"${o.line}"`).join(" Or: ")}`);
  behavior.push(kit.agree);

  const persona = {
    name,
    role: clip(b2b ? `${title} at ${company}, a ${industry.toLowerCase()} business` : `${title} (${industry.toLowerCase()})`, 200),
    behavior: clip(behavior.join(" "), 3000),
    openingLine: kit.opening(ctx),
  };

  const sampleReplies = b2b
    ? [
        `Sure, it's ${name}. Best number for me is 555-0137.`,
        "Right now we handle most of it with spreadsheets and a lot of phone calls, honestly.",
        "What does something like this cost?",
        "Timing is tough. Next month works better for my schedule.",
        "I hear you, but we've been burned by tools like this before, and the budget is tight.",
        "Okay, that's actually useful. How would it work for a team like ours?",
        "Thursday morning could work for a quick call.",
        "Sounds good, send me the invite. Thanks.",
      ]
    : input.callType === "collections"
      ? [
          `Yes, this is ${name}. You can reach me at 555-0137.`,
          "I know I'm behind. I lost some hours at work and things got tight.",
          "What would the monthly payment be? I can't pay the whole balance at once.",
          "I get paid on the fifteenth, so after that works with my schedule.",
          "I want to sort it out, but that's too much for me right now.",
          "Okay, that plan sounds good. Thanks for working with me.",
        ]
      : [
          `It's ${name}, and my number is 555-0137.`,
          "I'm at 18 Birch Lane.",
          "How much is this going to cost me?",
          "I'm free tomorrow morning or Thursday afternoon, if that works with your schedule.",
          "That makes sense, but it still seems like a lot, and money's tight right now.",
          "Can you tell me how the process works from here?",
          "Okay, sounds good. Thanks for your help.",
        ];

  const rubric: RubricCriterion[] = kit.rubric.map(([id, n, description, weight]) => ({ id, name: n, description, weight }));
  const scenario = finalize(
    {
      title: clip(b2b ? `${CALL_TYPE_LABELS[input.callType]}: ${title} at ${company}` : `${CALL_TYPE_LABELS[input.callType]}: ${title} (${industry})`, 120),
      industry,
      difficulty: input.difficulty,
      role: input.role,
      callType: input.callType,
      durationMin: kit.duration + (input.difficulty === "hard" ? 2 : 0),
      callScript: numberedTrack(kit.track(ctx)),
      aiPersona: persona,
      traineeGoal: kit.goal,
      rubric,
      objections,
      sampleReplies,
    },
    family,
  );

  chip("title", CALL_TYPE_LABELS[input.callType]);
  chip("industry", input.industry);
  chip("role", input.role);
  chip("callType", CALL_TYPE_LABELS[input.callType]);
  chip("difficulty", input.difficulty);
  chip("traineeGoal", CALL_TYPE_LABELS[input.callType]);
  chip("callScript", input.product || CALL_TYPE_LABELS[input.callType]);
  chip("aiPersona.openingLine", CALL_TYPE_LABELS[input.callType]);
  chip("sampleReplies", CALL_TYPE_LABELS[input.callType]);
  scenario.rubric.forEach((c, i) => {
    if (c.id === "compliance") chip(`rubric.${i}`, input.industry || input.role);
  });
  return { scenario, sources, method: "template" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generatePersona(input: WizardInput): Promise<WizardOutput> {
  if (llmKey()) {
    try {
      return await generateWithLlm(input);
    } catch (e) {
      console.error("[personaWizard] LLM generation failed, using the template:", (e as Error).message);
    }
  }
  return templatePersona(input);
}


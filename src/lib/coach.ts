import "server-only";
import { z } from "zod";
import { CueSchema, type CoachResult, type Cue, type CriterionEstimate } from "./coach-types";
import { APOLOGY_STEP_RE, isApology } from "./apology";
import { detectSlotOffer, gradeHeuristically } from "./grader";
import { chat, extractJson } from "./llm";
import { normalizeWeights, talkTrackSteps, type Objection, type ObjectionType, type RubricCriterion, type Scenario } from "./scenarios";
import { llmKey, llmModel } from "./serverConfig";

/**
 * Live coach. Called after every finished turn of a practice call; returns a
 * running rubric estimate, talk-track progress and at most one cue for the rep.
 * "user" turns are the rep (trainee), "assistant" turns are the AI persona.
 *
 * The heuristic path is deterministic and always available; the LLM path is
 * used when a key is configured and falls back to the heuristic on any error.
 */

export interface CoachTurnInput {
  role: "user" | "assistant";
  text: string;
}

export interface CoachOptions {
  /** False in Guided mode: estimate and talk track only, never a cue. */
  allowCue: boolean;
  /** Keys of cues shown recently; the coach never repeats one of these. */
  recentCueKeys?: string[];
  /**
   * Turns of a long call left out before the first one sent. Line numbers stay absolute,
   * so the first turn sent is line lineOffset + 1 and triggerTurn/evidenceLine match the client.
   */
  lineOffset?: number;
}

/**
 * The trailing part of a long transcript that fits the coach's limits, and how many turns
 * were left out in front. The live coach only needs recent context; rejecting the whole call
 * would freeze the rail for the rest of it.
 */
export function trailingWindow<T extends { text: string }>(turns: T[], maxTurns: number, maxChars: number): { turns: T[]; dropped: number } {
  let start = turns.length;
  let chars = 0;
  while (start > 0 && turns.length - start < maxTurns && chars + turns[start - 1].text.length <= maxChars) chars += turns[--start].text.length;
  return { turns: turns.slice(start), dropped: start };
}

/** Criteria with no trainee evidence yet are held at or below this score. */
export const PROVISIONAL_MAX = 20;
const LONG_TURN_WORDS = 70;
const STACKED_QUESTIONS = 3;
const WHISPER_RATIO = 0.7;
const WHISPER_MIN_TURNS = 4;
/** A live cue that arrives late is useless; fall back to the heuristic instead of waiting out llm.ts's 60 s timeout. */
const LLM_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Text helpers (same normalisation as grader.ts, reimplemented so grader stays untouched)
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
const STOP = new Set(
  "the a an and or of to in on for with is are be your you their this that it as at by from about when what how any all can will has have was were not but if then them they her his its our out up per get gets got into also more most very just than so do does did".split(" "),
);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => {
  const base = w.replace(/(ing|ed|es|s)$/, "");
  return new RegExp(`\\b${esc(base.length >= 4 ? base : w)}(?:s|es|ed|ing|e)?\\b`, "i");
};
const keywordsOf = (s: string) => [...new Set(norm(s).replace(/[^a-z0-9' ]/g, " ").split(" ").filter((w) => w.length > 3 && !STOP.has(w)))];
const stem = (w: string) => (w.length >= 5 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const splitSentences = (text: string) => (text.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 1);
const wordCount = (s: string) => (s.match(/[A-Za-z0-9$][A-Za-z0-9$'’-]*/g) ?? []).length;
/** Truncate to n chars on a word boundary, with an ellipsis. */
const clip = (s: string, n: number) => {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return `${(cut.replace(/\s+\S*$/, "") || cut).replace(/[,;:\s-]+$/, "")}…`;
};
function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

const GREETING_RE = /\b(hello|hi|hey|good (?:morning|afternoon|evening)|thanks? (?:you )?for calling|thank you for calling|this is|my name is|speaking|how can i help)\b/i;

/** A non-empty turn with its 1-based position in the transcript the client sent. */
interface Line {
  role: "user" | "assistant";
  text: string;
  line: number;
}

function spokenLines(transcript: CoachTurnInput[], offset = 0): Line[] {
  return transcript.map((t, i) => ({ role: t.role, text: t.text.trim(), line: offset + i + 1 })).filter((t) => t.text.length > 0);
}

function talkRatioOf(spoken: Line[]): number {
  let rep = 0;
  let all = 0;
  for (const t of spoken) {
    const n = wordCount(t.text);
    all += n;
    if (t.role === "user") rep += n;
  }
  return all ? Math.round((rep / all) * 100) / 100 : 0;
}

function weightedOverall(criteria: { score: number; weight: number }[]): number {
  const total = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return Math.round(criteria.reduce((a, c) => a + c.score * c.weight, 0) / total);
}

// ---------------------------------------------------------------------------
// Talk-track progress
// ---------------------------------------------------------------------------

/** Words in a step that say how to do it rather than what to cover. */
const GENERIC = new Set(
  "ask asks asking question questions give offer explain make sure clear clearly warmly politely calm calmly tone once plainly briefly quickly customer caller prospect trainee open next best state states using without real enough good".split(" "),
);

/** Loose synonyms so a step's keyword is credited when the rep says it in other words. */
const SYNONYMS: [RegExp, RegExp][] = [
  [/^urgen/, /\b(urgen\w*|emergenc\w*|asap|right away|how soon|how bad)\b/i],
  [/^(quote|proposal|estimate)/, /\b(quotes?|proposals?|estimates?|bids?)\b/i],
  [/^(callback|phone|number)$/, /\b(phone|number|call ?back|reach you|cell)\b/i],
  // Whole words only: a bare prefix also caught "feedback" and "feel".
  [/^(prices?|pricing|costs?|fees?)$/, /\$\s?\d|\b(prices?|pricing|costs?|fees?|charges?)\b/i],
  [/^(window|slot|appointment)/, /\b(windows?|slots?|appointments?|available|availability)\b/i],
  [/^arriv/, /\b(arriv\w*|on (the|their|his|her) way|eta|show up|text you)\b/i],
  [/^(concern|objection)/, /\b(concerns?|objections?|worr\w*|hesitat\w*)\b/i],
  [/^resolv/, /\b(resolv\w*|address(es|ed)? (that|your|the)|make sense|answer(s|ed)? (that|your))\b/i],
  [/^(thought|think)/, /\b(think|thought|feel|felt|impression|take on)\b/i],
  [/^permission$/, /\b(do you have (a|30|thirty|two|a few|a quick)|got (a|30|thirty|two) (minute|second)s?|quick (minute|second)|is (now|this) a (bad|good) time|caught you at a bad time|mind if)\b/i],
  [/^reason$/, /\b(reasons?|calling because|why i('m| am) calling|i noticed|i saw)\b/i],
];
const keywordMatcher = (w: string) => SYNONYMS.find(([k]) => k.test(w))?.[1] ?? wordRe(w);

const CONTACT_FIELDS: [RegExp, RegExp][] = [
  [/\bname\b/i, /\bname\b/i],
  [/\b(address|location)\b/i, /\b(address|street|zip|postcode|where (are you|do you live))\b/i],
  [/\b(number|phone|callback|call-back)\b/i, /\b(phone|number|call ?back|reach you|cell)\b/i],
  [/\be-?mail\b/i, /\be-?mail\b/i],
];
const PRICE_TALK_RE = /\$\s?\d|\b\d+\s?(dollars|bucks)\b|\b(fees?|prices?|pricing|costs?|charge[sd]?)\b/i;
const RECAP_RE = /\b(to confirm|confirm(ed|ing)?|just to recap|to recap|so that's|read (that|it) back|you're all set|you're booked|i've booked)\b/i;
/** "I understand how the billing works" and "You're right on time" are not acknowledgements. */
const ACK_RE =
  /\b(i (completely |totally |really |fully )?(hear|understand) (you|that|it|where|why|this|your)|i (completely |totally |really |fully )?(hear|understand|get|know|see) how (hard|difficult|painful|frustrating|stressful|upsetting|disappointing|maddening|exhausting)|i (completely |totally |really |fully )?understand what you((['’]re| are|['’]ve| have) (going|been|dealing|saying)| mean)|i (totally |really )?get (you|that|it|where|why)|i can (only )?imagine|how (frustrating|stressful|upsetting|disappointing|maddening|exhausting)|(that|this)(['’]s| sounds| must be| must have been| is| was) (so |really |incredibly |very )?(frustrating|stressful|upsetting|disappointing|maddening|exhausting|awful|terrible|rough|unacceptable)|(that|this|it) (should never have|should not have|shouldn['’]t have) happened|you(['’]re| are) (absolutely |completely |totally )?right(?= (about|that|and)\b|\s*([,.!;\n]|$))|fair (question|point|enough)|that makes sense|i appreciate|totally (get|understand)|good question|i see why|that's (fair|understandable))\b/i;
/** What an apology step asks for besides the apology: the step without its apology clause or anything the rep should not do. */
const apologyRemainder = (step: string) =>
  step
    .split(/[,;:.]|\b(?:and|then)\b/i)
    .filter((part) => !/\b(apolog\w*|say(ing)? sorry)\b/i.test(part))
    .map((part) => part.replace(/\b(without|never|not|no need to|don['’]t|avoid|instead of|rather than)\b.*/i, ""))
    .join(" ");
const CLARIFY_RE = /\b(compar\w*|what do you mean|when you say|versus|vs\.?|against|relative to)\b/i;
const ASK_RE = /\b(can we|could we|shall we|would you be open|are you open|let's (set|book|schedule|get|start|lock)|how about|move forward|get (you )?started|start (a|the|with)|sign|lock (it|that) in)\b/i;

interface StepCtx {
  scenario: Scenario;
  spoken: Line[];
  repTurns: Line[];
  sentences: { text: string; line: number }[];
  allRep: string;
}

const apologized = (c: StepCtx) => c.sentences.some((s) => isApology(s.text));
/** Words in a step that say what to cover. */
const stepKeywords = (step: string) => keywordsOf(step).filter((w) => !GENERIC.has(w));
/** The rep said at least 40% of the keywords, counting synonyms. */
const coversKeywords = (kws: string[], allRep: string) => kws.filter((w) => keywordMatcher(w).test(allRep)).length >= Math.max(1, Math.ceil(kws.length * 0.4));

/** Specific detectors for common step types; when any applies to a step, all that apply must fire. */
const STEP_CONCEPTS: { step: RegExp; done: (c: StepCtx, step: string) => boolean }[] = [
  { step: /\b(greet\w*|introduc\w*|hello|welcome)\b/i, done: (c) => c.repTurns.slice(0, 2).some((t) => GREETING_RE.test(t.text)) },
  {
    step: /\b(collect|capture|get|take|gather|ask for|record)\b.*\b(name|address|number|phone|e-?mail|contact)/i,
    done: (c, step) => {
      const fields = CONTACT_FIELDS.filter(([s]) => s.test(step));
      const pool = fields.length ? fields : CONTACT_FIELDS;
      const need = Math.max(1, Math.ceil((pool.length * 2) / 3));
      return pool.filter(([, rep]) => rep.test(c.allRep)).length >= need;
    },
  },
  { step: /\b(explain|quote|discuss|present|give|share|state|mention|cover)\w*\b[^.]*\b(fees?|price|pricing|costs?)\b/i, done: (c) => PRICE_TALK_RE.test(c.allRep) },
  {
    step: /\b(objections?|brush-?off|push-?back)\b/i,
    // Done once the caller has raised an objection and the rep's next reply engaged with it.
    done: (c) =>
      c.spoken.some((t, i) => {
        if (t.role !== "assistant") return false;
        const m = matchObjection(c.scenario, t.text);
        const reply = c.spoken.slice(i + 1).find((x) => x.role === "user");
        return Boolean(m && reply && answersObjection(m, reply.text));
      }),
  },
  { step: /\b(appointment|window|slot|book\w*|schedul\w*)\b/i, done: (c) => Boolean(detectSlotOffer(c.sentences).offered) },
  { step: /\b(confirm\w*|recap\w*|summari[sz]\w*|read back)\b/i, done: (c) => RECAP_RE.test(c.allRep) },
  // "validate", not "validation period". An apology also acknowledges the problem.
  { step: /\b(acknowledg\w*|empathi[sz]\w*|validat(e|es|ed|ing))\b/i, done: (c) => ACK_RE.test(c.allRep) || apologized(c) },
  {
    step: APOLOGY_STEP_RE,
    // The apology does not stand in for the rest of a step that asks for more, such as naming the agency.
    done: (c, step) => {
      if (!apologized(c)) return false;
      const rest = stepKeywords(apologyRemainder(step));
      return rest.length < 3 || coversKeywords(rest, c.allRep);
    },
  },
  { step: /\bclarif\w*/i, done: (c) => c.sentences.some((s) => s.text.includes("?") && CLARIFY_RE.test(s.text)) },
  {
    step: /\b(ask for (the|a) (decision|commitment|meeting|business)|firm commitment|propose a (clear |dated )?next step)\b/i,
    done: (c) => Boolean(detectSlotOffer(c.sentences).offered) || ASK_RE.test(c.allRep),
  },
];

function stepDone(step: string, ctx: StepCtx): boolean {
  const concepts = STEP_CONCEPTS.filter((c) => c.step.test(step));
  if (concepts.length) return concepts.every((c) => c.done(ctx, step));
  const kws = stepKeywords(step);
  return kws.length > 0 && coversKeywords(kws, ctx.allRep);
}

function stepFlags(scenario: Scenario, steps: string[], spoken: Line[]): boolean[] {
  const repTurns = spoken.filter((t) => t.role === "user");
  const ctx: StepCtx = {
    scenario,
    spoken,
    repTurns,
    sentences: repTurns.flatMap((t) => splitSentences(t.text).map((text) => ({ text, line: t.line }))),
    allRep: repTurns.map((t) => t.text).join(" \n"),
  };
  return steps.map((s) => stepDone(s, ctx));
}

// ---------------------------------------------------------------------------
// Objections
// ---------------------------------------------------------------------------

/** Checked in this order: the more specific types first. */
const OBJECTION_RES: [ObjectionType, RegExp][] = [
  ["competitor", /\b(another (company|vendor|contractor|provider|quote|number|bid|option)|other (company|companies|vendor|contractor|provider|quote|guys|option)|someone else|competitor|already (use|using|work with|have (a|an|someone))|(they|he|she) (came in|quoted|offered)|cheaper (elsewhere|somewhere))\b/i],
  ["authority", /\b((talk|speak|check|discuss)( it)?( over)? (to|with) (my|the|our) (wife|husband|partner|spouse|boss|manager|team|board|cfo|ceo|owner)|run it by|not my (decision|call)|need (approval|sign-?off|to get approval)|decision ?maker|above my pay grade)\b/i],
  ["trust", /\b(how do i know|can you (confirm|guarantee|promise|prove)|will (someone|they|you) really|really (show up|work)|scam|(don't|do not|can't) trust|sounds too good|heard bad things|is this (legit|real)|been burned)\b/i],
  ["price", /\b(too (expensive|much|pricey)|expensive|pricey|(can't|cannot|couldn't) afford|budget|cheaper|discount|how much|a lot of money|(twice|double|more than) what (we|i) pay)\b|\b(fees?|costs?|price|pricing|charge)\b[^.!]*\?/i],
  ["timing", /\b(not (a good|the right) time|bad time|(really|too|pretty|super) busy|call (me )?back (later|next)|not right now|maybe later|next (month|quarter|year)|not ready|in a few (weeks|months)|wait (until|till)|(\d+[- ]month|long|annual|multi-year) contract|contract length)\b/i],
  ["status_quo", /\b(we('re| are) (fine|good|all set|happy|ok(ay)?)( with)?|(it|that) works (fine|for us|okay)|happy with (what|our|the)|don't (want|need) to (change|switch)|(current|existing) (vendor|provider|setup|system|tool)|always done it)\b/i],
  ["need", /\b(don't (really )?need|no need|not interested|not (a|any) (priority|problem|issue)|why would (i|we) (need|want)|not sure (we|i) need|we('re| are) not looking|doesn't apply)\b/i],
];

/** Signs that the rep's reply actually engaged with an objection of this type. */
const ANSWER_RES: Record<ObjectionType, RegExp> = {
  price: /\$\s?\d|\b\d+\s?(dollars|bucks)\b|\b(fees?|costs?|prices?|pricing|charge[sd]?|credited|included|free|no charge|roi|worth|value)\b/i,
  timing: /\b(timeline|timing|schedule|month-to-month|trial|pilot|what would need to|when would)\b/i,
  competitor: /\b(compar\w*|includ\w*|warranty|differen\w*|versus|apples)\b/i,
  authority: /\b(together|both of you|join|loop (her|him|them) in|invite|what (will|would|might) (she|he|they)|questions (will|would|might) (she|he|they))\b/i,
  trust: /\b(guarantee\w*|text|promise|reviews?|references?|licensed|insured|warranty|i'll call you|you'll get)\b/i,
  status_quo: /\b(what (would|does|do)|cost of|change|compared to|currently|today)\b[^.!]*\?/i,
  need: /\b(what|how|why)\b[^.!]*\?/i,
};

const OBJECTION_COPY: Record<ObjectionType, { title: string; message: string; line: string; criterion: RegExp[] }> = {
  price: {
    title: "Price objection: answer it directly",
    message: "They asked about cost. Give the number plainly, say what it covers, then move on.",
    line: "Fair question. Let me give you the exact price and what it includes, so there are no surprises.",
    criterion: [/fee|pric|cost|transparen/i, /value|roi|reframe/i, /objection/i],
  },
  timing: {
    title: "Timing objection: find the real reason",
    message: "This may be a brush-off. Acknowledge it, then ask one question to find the real hold-up.",
    line: "Totally understand. Is it the timing itself, or is something else holding this up?",
    criterion: [/second|timing|urgen/i, /objection/i],
  },
  competitor: {
    title: "Competitor mention: compare value, not price",
    message: "Don't discount yet. Ask what the other option includes and compare like for like.",
    line: "Thanks for telling me. Can we compare what's included side by side?",
    criterion: [/competit/i, /objection/i, /value|differen/i],
  },
  authority: {
    title: "Decision maker: learn their process",
    message: "Ask who else decides and what they need from you. Offer to help, and work within their process.",
    line: "That makes sense. What do you think they'll want to know? I'm happy to walk you both through it.",
    criterion: [/stakeholder|decision/i, /objection/i],
  },
  trust: {
    title: "Trust concern: reassure with specifics",
    message: "Reassure with specifics: who is coming, when, and how you'll keep them updated.",
    line: "Completely fair. Here's exactly what happens next, and I'll call you if anything changes.",
    criterion: [/trust/i, /expectation|next.?step/i, /objection/i, /confirm/i, /rapport/i],
  },
  status_quo: {
    title: "Status quo: ask what it costs them",
    message: "Don't argue with what works. Ask what the current setup costs them or what they'd change.",
    line: "Glad it's working. If you could change one thing about it, what would it be?",
    criterion: [/objection/i, /discover|value/i],
  },
  need: {
    title: "No need: dig into the problem",
    message: "Don't push. Ask about how they handle the problem today.",
    line: "Understood. Out of curiosity, how are you handling that today?",
    criterion: [/need|pain/i, /objection/i, /discover/i],
  },
};

/** Collections calls are not sales calls: same playbook slots, but the advice never pushes for a sale. */
const COLLECTIONS_COPY: Partial<Record<ObjectionType, { title: string; message: string }>> = {
  price: { title: "Can't pay: explore what is realistic", message: "Ask what they can manage. Explain the options plainly and never threaten." },
  timing: { title: "Timing: agree on a realistic date", message: "Acknowledge it, then ask what date and amount work. Offer a documented plan or a short hold." },
  trust: { title: "Trust concern: verify, then explain", message: "Verify identity first, then explain who you are and how they can check the debt in writing." },
  status_quo: { title: "Pushback: listen and note it", message: "Don't argue. Ask what they need and honor any request about how you contact them." },
  need: { title: "Dispute or pushback: listen first", message: "Don't push. Ask what they believe is wrong and explain how to dispute it in writing." },
};

function matchObjection(scenario: Scenario, text: string): { type: ObjectionType; objection?: Objection } | null {
  const said = new Set(keywordsOf(text).map(stem));
  let best: { o: Objection; ratio: number } | null = null;
  for (const o of scenario.objections) {
    const kws = keywordsOf(o.line).map(stem);
    if (!kws.length) continue;
    const shared = kws.filter((w) => said.has(w)).length;
    const ratio = shared / kws.length;
    const hit = (ratio >= 0.5 && shared >= 2) || shared >= 3 || (kws.length <= 2 && shared === kws.length);
    if (hit && (!best || ratio > best.ratio)) best = { o, ratio };
  }
  if (best) return { type: best.o.type, objection: best.o };
  for (const [type, re] of OBJECTION_RES) {
    if (re.test(text)) return { type, objection: scenario.objections.find((o) => o.type === type) };
  }
  return null;
}

function answersObjection(m: { type: ObjectionType; objection?: Objection }, reply: string): boolean {
  if (ANSWER_RES[m.type].test(reply)) return true;
  if (!m.objection?.prepAnswer) return false;
  const said = new Set(keywordsOf(reply).map(stem));
  return keywordsOf(m.objection.prepAnswer).map(stem).filter((w) => said.has(w)).length >= 2;
}

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

interface CueCandidate {
  cue: Cue;
  key: string;
}

const criterionText = (c: RubricCriterion) => `${c.id} ${c.name} ${c.description}`;
/** First criterion matching the earliest pattern that matches any criterion (patterns in priority order). */
function criterionFor(rubric: RubricCriterion[], patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const hit = rubric.find((c) => re.test(criterionText(c)));
    if (hit) return hit.id;
  }
  return undefined;
}

/** Rubric criterion sharing the most keywords with a piece of text, if any. */
function criterionByOverlap(rubric: RubricCriterion[], text: string): string | undefined {
  const words = new Set(keywordsOf(text).filter((w) => !GENERIC.has(w)).map(stem));
  let best: { id: string; n: number } | undefined;
  for (const c of rubric) {
    const n = keywordsOf(criterionText(c)).map(stem).filter((w) => words.has(w)).length;
    if (n > 0 && (!best || n > best.n)) best = { id: c.id, n };
  }
  return best?.id;
}

function objectionCue(scenario: Scenario, spoken: Line[]): CueCandidate | null {
  const i = findLastIndex(spoken, (t) => t.role === "assistant");
  if (i < 0) return null;
  const m = matchObjection(scenario, spoken[i].text);
  if (!m) return null;
  const reply = spoken.slice(i + 1).filter((t) => t.role === "user").map((t) => t.text).join(" ");
  if (reply && answersObjection(m, reply)) return null;
  const copy = { ...OBJECTION_COPY[m.type], ...(scenario.callType === "collections" ? COLLECTIONS_COPY[m.type] : {}) };
  return {
    key: `objection:${m.type}`,
    cue: {
      type: "objection",
      title: copy.title,
      message: reply ? `You moved on without answering it. ${copy.message}` : copy.message,
      suggestedLine: clip(m.objection?.prepAnswer || copy.line, 300),
      triggerTurn: spoken[i].line,
      criterionId: criterionFor(scenario.rubric, [...copy.criterion, /handl/i]),
    },
  };
}

function guardrailCue(scenario: Scenario, spoken: Line[]): CueCandidate | null {
  const i = findLastIndex(spoken, (t) => t.role === "user");
  // Only coach the rep's latest turn while it is still fresh.
  if (i < 0 || i < spoken.length - 2) return null;
  const rep = spoken[i];
  const questions = (rep.text.match(/\?/g) ?? []).length;
  const words = wordCount(rep.text);
  const criterionId = criterionFor(scenario.rubric, [/listen/i, /question|discover|clarif/i, /rapport/i]);
  if (questions >= STACKED_QUESTIONS) {
    const first = splitSentences(rep.text).find((s) => s.includes("?"));
    return {
      key: "guardrail:length",
      cue: {
        type: "guardrail",
        title: "One question at a time",
        message: `You asked ${questions} questions at once. Ask the one that matters most and let them answer.`,
        suggestedLine: first ? clip(first, 300) : undefined,
        triggerTurn: rep.line,
        criterionId,
      },
    };
  }
  if (words > LONG_TURN_WORDS) {
    return {
      key: "guardrail:length",
      cue: {
        type: "guardrail",
        title: "Keep it short",
        message: `That turn ran ${words} words. Pause and hand the conversation back.`,
        suggestedLine: "Let me pause there. What questions do you have so far?",
        triggerTurn: rep.line,
        criterionId,
      },
    };
  }
  return null;
}

function whisperCue(scenario: Scenario, spoken: Line[], talkRatio: number): CueCandidate | null {
  if (spoken.length < WHISPER_MIN_TURNS || talkRatio <= WHISPER_RATIO) return null;
  const i = findLastIndex(spoken, (t) => t.role === "user");
  return {
    key: "whisper:ratio",
    cue: {
      type: "whisper",
      title: "Let them talk",
      message: `You've done about ${Math.round(talkRatio * 100)}% of the talking. Ask an open question and listen.`,
      suggestedLine: "What matters most to you here?",
      triggerTurn: spoken[i >= 0 ? i : spoken.length - 1].line,
      criterionId: criterionFor(scenario.rubric, [/listen/i, /question|discover/i]),
    },
  };
}

function nextStepCue(scenario: Scenario, spoken: Line[], steps: string[], flags: boolean[]): CueCandidate | null {
  if (!flags.some(Boolean)) return null;
  const idx = flags.findIndex((f) => !f);
  if (idx < 0 || !spoken.length) return null;
  const step = steps[idx].replace(/[.;:,\s]+$/, "");
  return {
    key: `step:${idx}`,
    cue: {
      type: "next_question",
      title: clip(`Next: ${step}`, 80),
      message: clip(steps[idx], 240),
      triggerTurn: spoken[spoken.length - 1].line,
      criterionId: criterionByOverlap(scenario.rubric, step),
    },
  };
}

function finalizeCue(c: CueCandidate | null): CueCandidate | null {
  if (!c) return null;
  const parsed = CueSchema.safeParse(c.cue);
  return parsed.success ? { cue: parsed.data, key: c.key } : null;
}

// ---------------------------------------------------------------------------
// Heuristic path
// ---------------------------------------------------------------------------

/** Deterministic coach used without an LLM key and as the fallback on any LLM error. */
export function coachHeuristic(scenario: Scenario, transcript: CoachTurnInput[], opts: CoachOptions): CoachResult {
  const t0 = Date.now();
  const spoken = spokenLines(transcript, opts.lineOffset);
  const steps = talkTrackSteps(scenario.callScript);

  // gradeHeuristically numbers lines among the turns it is given; map them back to transcript lines.
  const graded = gradeHeuristically(scenario, spoken.map((t) => ({ role: t.role, text: t.text })));
  const criteria: CriterionEstimate[] = graded.criteria.map((c) => {
    const best = c.evidence.find((e) => e.speaker === "trainee" && e.line);
    const evidenceLine = best?.line ? spoken[best.line - 1]?.line : undefined;
    const confirmed = evidenceLine !== undefined;
    return { id: c.id, name: c.name, weight: c.weight, score: confirmed ? c.score : Math.min(c.score, PROVISIONAL_MAX), confirmed, evidenceLine };
  });

  const flags = stepFlags(scenario, steps, spoken);
  const talkRatio = talkRatioOf(spoken);

  let picked: CueCandidate | null = null;
  if (opts.allowCue && spoken.length) {
    const recent = new Set(opts.recentCueKeys ?? []);
    const candidates: (() => CueCandidate | null)[] = [
      () => objectionCue(scenario, spoken),
      () => guardrailCue(scenario, spoken),
      () => whisperCue(scenario, spoken, talkRatio),
      () => nextStepCue(scenario, spoken, steps, flags),
    ];
    for (const make of candidates) {
      const c = finalizeCue(make());
      if (c && !recent.has(c.key)) {
        picked = c;
        break;
      }
    }
  }

  return {
    estimate: { overall: weightedOverall(criteria), criteria },
    steps: flags,
    cue: picked?.cue ?? null,
    cueKey: picked?.key,
    talkRatio,
    source: "heuristic",
    latencyMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

const LlmCoachOutput = z.object({
  criteria: z
    .array(z.object({ id: z.coerce.string(), score: z.coerce.number().catch(0), quote: z.string().nullish() }))
    .default([]),
  steps: z.array(z.unknown()).default([]),
  cue: z.unknown().optional(),
});

function buildPrompt(scenario: Scenario, spoken: Line[], steps: string[], rubric: RubricCriterion[], opts: CoachOptions) {
  const recent = opts.recentCueKeys ?? [];
  const system = [
    "You are a live sales-call coach whispering to a rep (the TRAINEE) during a practice phone call with an AI persona (the CALLER). Only the trainee sees your output; the caller never does.",
    "Respond with JSON only, no prose:",
    '{"criteria":[{"id":string,"score":0-100,"quote":string}],"steps":[boolean,...],"cue":null | {"type":"objection"|"next_question"|"whisper"|"guardrail","title":string,"message":string,"suggestedLine":string,"triggerTurn":number,"criterionId":string,"key":string}}',
    "",
    "SCORING",
    "- Give every rubric id a 0-100 score: partial credit for what the trainee has shown SO FAR. The call is still running, so leave things that naturally come later low instead of penalising them.",
    '- quote: a verbatim, contiguous substring of ONE TRAINEE line that best supports the score, or "" if there is none. Never quote the caller and never paraphrase. A criterion without a valid trainee quote is treated as not yet shown and capped at 20.',
    `- steps: exactly ${steps.length} booleans, one per talk-track step in order; true once the trainee has clearly done that step.`,
    "",
    "CUE (at most one)",
    "- If CUE ALLOWED is no, cue must be null.",
    "- Only give a cue that is genuinely useful right now, based on the last few lines. Prefer null to filler or praise.",
    "- Priorities: an objection in the caller's latest line that the trainee has not answered (type objection); the trainee's last line being long-winded or stacking several questions (type guardrail); the trainee doing most of the talking (type whisper); otherwise the next talk-track step or the best next question (type next_question).",
    "- title: at most 60 characters. message: one sentence, at most 200 characters. suggestedLine: something the trainee can say out loud next, 1-2 short sentences, first person, consistent with the scenario facts (use the objection bank's prep answers when they fit).",
    '- triggerTurn: the line number that triggered the cue. criterionId: the rubric id the cue serves, or "".',
    '- key: a short stable id such as "objection:price", "guardrail:length", "whisper:ratio", "step:<talk-track index>" or "<type>:<topic>". Never return a cue whose key is in RECENT CUE KEYS.',
    "- Coach the trainee only. Never write lines for the caller, never suggest what the persona should say or do.",
  ].join("\n");

  const user = [
    `SCENARIO: ${scenario.title} (${scenario.industry || "general"}; ${scenario.callType} call)`,
    `TRAINEE GOAL: ${scenario.traineeGoal}`,
    `RUBRIC:\n${rubric.map((c) => `- id=${c.id} | ${c.name} (weight ${c.weight.toFixed(0)}%): ${c.description}`).join("\n")}`,
    `TALK TRACK (${steps.length} steps, index in brackets):\n${steps.length ? steps.map((s, i) => `[${i}] ${s}`).join("\n") : "(none)"}`,
    `OBJECTION BANK:\n${scenario.objections.length ? scenario.objections.map((o) => `- ${o.type}: "${o.line}" | prep answer: "${o.prepAnswer}"`).join("\n") : "(none)"}`,
    `RECENT CUE KEYS: ${recent.length ? recent.join(", ") : "(none)"}`,
    `CUE ALLOWED: ${opts.allowCue ? "yes" : "no"}`,
    // A long call arrives as its most recent lines; say so, or the model reads the window as the whole call.
    `${(spoken[0]?.line ?? 1) > 1 ? `TRANSCRIPT, most recent lines only (lines 1-${spoken[0].line - 1} happened earlier and are not shown; line numbers in brackets)` : "TRANSCRIPT (line numbers in brackets)"}:\n${spoken.map((t) => `[${t.line}] ${t.role === "user" ? "TRAINEE" : "CALLER"}: ${t.text}`).join("\n")}`,
  ].join("\n\n");
  return { system, user };
}

/** Returns the transcript line of the trainee turn containing the quote, or undefined if it is not verbatim. */
function verifyQuote(quote: string | null | undefined, spoken: Line[]): number | undefined {
  const q = norm(quote ?? "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "")
    .trim();
  if (q.length < 4) return undefined;
  return spoken.find((t) => t.role === "user" && norm(t.text).includes(q))?.line;
}

function parseLlmCue(raw: unknown, spoken: Line[], rubric: RubricCriterion[], recent: Set<string>): CueCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const firstLine = spoken[0]?.line ?? 1;
  const lastLine = spoken[spoken.length - 1]?.line ?? 1;
  const turn = Math.round(Number(r.triggerTurn));
  const criterionId = str(r.criterionId);
  const parsed = CueSchema.safeParse({
    type: r.type,
    title: clip(str(r.title), 80),
    message: clip(str(r.message), 240),
    suggestedLine: str(r.suggestedLine) ? clip(str(r.suggestedLine), 300) : undefined,
    triggerTurn: Number.isFinite(turn) ? Math.min(Math.max(turn, firstLine), lastLine) : lastLine,
    criterionId: rubric.some((c) => c.id === criterionId) ? criterionId : undefined,
  });
  if (!parsed.success) return null;
  const cue = parsed.data;
  const key = clip(str(r.key).toLowerCase().replace(/\s+/g, "") || `${cue.type}:${cue.criterionId ?? keywordsOf(cue.title).slice(0, 2).join("-")}`, 80);
  return recent.has(key) ? null : { cue, key };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("COACH_LLM_TIMEOUT")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function coachWithLlm(scenario: Scenario, spoken: Line[], opts: CoachOptions): Promise<Omit<CoachResult, "latencyMs">> {
  const rubric = normalizeWeights(scenario.rubric);
  const steps = talkTrackSteps(scenario.callScript);
  const { system, user } = buildPrompt(scenario, spoken, steps, rubric, opts);
  const text = await withTimeout(
    chat([{ role: "system", content: system }, { role: "user", content: user }], { json: true, maxTokens: 700, temperature: 0.2 }),
    LLM_TIMEOUT_MS,
  );
  const out = LlmCoachOutput.parse(extractJson(text));

  const criteria: CriterionEstimate[] = rubric.map((c) => {
    const r = out.criteria.find((x) => x.id === c.id);
    const evidenceLine = verifyQuote(r?.quote, spoken);
    const confirmed = evidenceLine !== undefined;
    const raw = Math.max(0, Math.min(100, Math.round(Number.isFinite(r?.score) ? (r?.score as number) : 0)));
    return { id: c.id, name: c.name, weight: c.weight, score: confirmed ? raw : Math.min(raw, PROVISIONAL_MAX), confirmed, evidenceLine };
  });
  const flags = steps.map((_, i) => {
    const v = out.steps[i];
    return v === true || v === "true" || v === 1;
  });
  const picked = opts.allowCue ? parseLlmCue(out.cue, spoken, rubric, new Set(opts.recentCueKeys ?? [])) : null;

  return {
    estimate: { overall: weightedOverall(criteria), criteria },
    steps: flags,
    cue: picked?.cue ?? null,
    cueKey: picked?.key,
    talkRatio: talkRatioOf(spoken),
    source: "llm",
    model: llmModel(),
  };
}

/** One live-coach update for the transcript so far. Never throws for LLM problems; falls back to the heuristic. */
export async function coachTurn(scenario: Scenario, transcript: CoachTurnInput[], opts: CoachOptions): Promise<CoachResult> {
  const t0 = Date.now();
  const spoken = spokenLines(transcript, opts.lineOffset);
  if (llmKey() && spoken.length) {
    try {
      const result = await coachWithLlm(scenario, spoken, opts);
      return { ...result, latencyMs: Date.now() - t0 };
    } catch (e) {
      console.error("[coach] LLM coach failed, falling back to heuristic:", (e as Error).message);
    }
  }
  return { ...coachHeuristic(scenario, transcript, opts), latencyMs: Date.now() - t0 };
}

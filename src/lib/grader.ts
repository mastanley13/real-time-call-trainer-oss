import "server-only";
import { z } from "zod";
import { APOLOGY_STEP_RE, isApology } from "./apology";
import { chat, extractJson } from "./llm";
import { llmKey, llmModel } from "./serverConfig";
import { Scenario, normalizeWeights } from "./scenarios";

export interface Turn {
  role: "user" | "assistant" | "system";
  text: string;
}

import type { CriterionResult, Evaluation, GoalStatus } from "./grader-types";
import { GRADER_VERSIONS } from "./grader-types";
export type { CriterionResult, Evaluation };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

export function gradeFor(score: number): Evaluation["grade"] {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

function weightedOverall(criteria: { score: number; weight: number }[]): number {
  const total = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return Math.round(criteria.reduce((a, c) => a + c.score * c.weight, 0) / total);
}

function formatTranscript(turns: Turn[]): string {
  return turns
    .filter((t) => t.role !== "system")
    .map((t) => `${t.role === "user" ? "TRAINEE" : "CALLER"}: ${t.text}`)
    .join("\n");
}

const LlmOutput = z.object({
  summary: z.string(),
  criteria: z.array(
    z.object({
      id: z.string(),
      score: z.coerce.number(),
      rationale: z.string(),
      evidence: z.array(z.object({ speaker: z.string().optional(), quote: z.string() })).default([]),
    }),
  ),
  strengths: z.array(z.string()).default([]),
  improvements: z.array(z.string()).default([]),
  goalStatus: z.enum(["achieved", "partial", "not_achieved"]).optional(),
  goalAchieved: z.boolean().optional(),
  goalExplanation: z.string().default(""),
});

const NEGATION_RE = /\b(?:did not|didn't|never|missed|failed to|did no)\b(.*)/i;

/** Drops any sentence claiming a miss for a concept that a trainee quote under the same criterion contains. */
function dropContradictions(rationale: string, evidence: CriterionResult["evidence"]): string {
  const quotes = evidence.filter((e) => e.speaker === "trainee");
  if (!quotes.length) return rationale;
  const kept = splitSentences(rationale).filter((sentence) => {
    const m = NEGATION_RE.exec(sentence);
    return !(m && keywordsOf(m[1]).map(wordRe).some((re) => quotes.some((q) => re.test(q.quote))));
  });
  return kept.length ? kept.join(" ") : "You made a real attempt at this; see the quotes below.";
}

async function gradeWithLlm(scenario: Scenario, turns: Turn[]): Promise<Evaluation> {
  const rubric = normalizeWeights(scenario.rubric);
  const system = [
    "You are an exacting sales/phone-call coach grading a trainee's practice call against a rubric.",
    "The TRAINEE is the human practising. The CALLER is an AI persona. Grade only the trainee.",
    "For EVERY rubric criterion give a 0-100 score, a one-or-two sentence rationale, and 1-3 evidence quotes.",
    "Evidence quotes MUST be copied verbatim from the transcript (a contiguous substring of one turn). Never invent or paraphrase. If there is no supporting evidence, return an empty evidence array and score low.",
    "VERIFY BEFORE CLAIMING A MISS: before you write that the trainee missed, skipped, never did or did not do something, search the whole TRAINEE transcript for it first. If it appears anywhere, it is NOT a miss: credit it and quote it. If something was only partly covered, say so in a natural, complete sentence (e.g. 'You mentioned the fee but did not explain how it is billed.'); never use stock phrases or fragments.",
    "VOICE: write ALL feedback (summary, rationales, strengths, improvements, goalExplanation) in the second person, addressing the trainee as 'you'. Never use the trainee's name, 'the trainee', or 'the rep'. Every item must be a natural, grammatical, complete sentence.",
    "Evidence quotes belong ONLY under the criterion they directly support; never reuse a quote under an unrelated criterion. The rationale and evidence of a criterion must agree: never say the trainee 'did not' do something that a quote under the same criterion shows they did.",
    "Calibration: score what the trainee actually did, on a fair 0-100 scale (50 = attempted but weak, 70 = competent, 90+ = excellent). Give PARTIAL credit (roughly 50-70) for a criterion when the trainee made a real attempt, even if the caller did not agree or the step was not completed.",
    "Booking/closing/next-step criteria: if the trainee proposed a concrete appointment slot (a specific day and/or time window) but the caller never confirmed it, award partial credit (about 55-70). Award 80+ only when the slot was confirmed and the trainee recapped the details. Score below 30 only when no slot or next step was offered at all. Do not penalise the trainee for the caller's refusal or silence.",
    "goalStatus: 'achieved' (goal fully met, e.g. appointment confirmed), 'partial' (clear progress, e.g. a concrete slot was offered but not confirmed), or 'not_achieved' (little or no progress).",
    "Respond with JSON only: {summary, criteria:[{id, score, rationale, evidence:[{speaker:'trainee'|'caller', quote}]}], strengths:[], improvements:[], goalStatus:'achieved'|'partial'|'not_achieved', goalExplanation}.",
  ].join("\n");
  const user = [
    `SCENARIO: ${scenario.title} (${scenario.industry})`,
    `TRAINEE GOAL: ${scenario.traineeGoal}`,
    `EXPECTED TALK TRACK:\n${scenario.callScript}`,
    `RUBRIC:\n${rubric.map((c) => `- id=${c.id} | ${c.name} (weight ${c.weight.toFixed(0)}%): ${c.description}`).join("\n")}`,
    `TRANSCRIPT:\n${formatTranscript(turns)}`,
  ].join("\n\n");

  // Read the model before the call so the stored provenance names what actually graded this transcript.
  const model = llmModel();
  const out = LlmOutput.parse(extractJson(await chat([{ role: "system", content: system }, { role: "user", content: user }], { json: true })));
  // Line numbers/speakers come from the transcript itself, not from the model.
  const haystack = turns.map((t) => norm(t.text));

  const criteria: CriterionResult[] = rubric.map((c) => {
    const r = out.criteria.find((x) => x.id === c.id);
    const evidence = (r?.evidence ?? [])
      .map((e) => ({ e, idx: haystack.findIndex((h) => h.includes(norm(e.quote))) }))
      .filter(({ e, idx }) => e.quote.trim().length > 3 && idx >= 0)
      .slice(0, 3)
      .map(({ e, idx }) => ({ speaker: (turns[idx].role === "user" ? "trainee" : "caller") as "trainee" | "caller", quote: e.quote.trim(), line: idx + 1 }));
    return {
      id: c.id,
      name: c.name,
      weight: c.weight,
      score: Math.max(0, Math.min(100, Math.round(r?.score ?? 0))),
      rationale: r ? dropContradictions(r.rationale, evidence) : "The grader returned no assessment for this criterion.",
      evidence,
    };
  });
  const overallScore = weightedOverall(criteria);
  const status: GoalStatus = out.goalStatus ?? (out.goalAchieved ? "achieved" : "not_achieved");
  return {
    method: "llm",
    graderVersion: GRADER_VERSIONS.llm,
    model,
    overallScore,
    grade: gradeFor(overallScore),
    summary: out.summary,
    criteria,
    strengths: out.strengths.slice(0, 5),
    improvements: out.improvements.slice(0, 5),
    goalAchievement: { achieved: status === "achieved", status, explanation: out.goalExplanation },
  };
}

const STOP = new Set(
  "the a an and or of to in on for with is are be your you their this that it as at by from about when what how any all can will has have was were not but if then them they her his its our out up per get gets got into also more most very just than so do does did".split(" "),
);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word matcher that tolerates a plural/verb suffix ("fee" matches "fees"). */
const wordRe = (w: string) => {
  const base = w.replace(/(ing|ed|es|s)$/, "");
  return new RegExp(`\\b${esc(base.length >= 4 ? base : w)}(?:s|es|ed|ing|e)?\\b`, "i");
};
const keywordsOf = (s: string) => [...new Set(norm(s).replace(/[^a-z0-9' ]/g, " ").split(" ").filter((w) => w.length > 3 && !STOP.has(w)))];

const MAX_HITS_PER_SENTENCE = 2;
const GREETING_RE = /\b(hello|hi|hey|good (?:morning|afternoon|evening)|thanks? (?:you )?for calling|thank you for calling|this is|my name is|speaking|how can i help)\b/i;

const BOOKING_CRITERION_RE = /book|clos|appoint|schedul|next.?step|commit|confirm|wrap/i;
const SLOT_TIME_RE = /\b(\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)|noon|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this (morning|afternoon|evening|week)|(morning|afternoon|evening) (window|slot))\b/i;
// Only counts alongside SLOT_TIME_RE, so broad verbs ("Can I send...", "I can show it Saturday") stay safe.
const SLOT_OFFER_RE = /\b(how about|would .* work|does .* work|can (do|offer|get|send|have)|(i|we) can (do|offer|get|send|show|meet|come|bring|have)|can (i|we) (do|offer|get|send|show|meet|come|book|set|pencil)|i have|we have|available|opening|slot|window|come out|stop by|schedule|book|appointment|visit|see you)\b/i;
const SLOT_CONFIRM_RE = /\b(confirm(ed|ing)?|you're (booked|all set|scheduled)|i've (booked|scheduled|put you)|locked in|see you (then|at|on|tomorrow)|all set)\b/i;

/** Trainee proposed a concrete day/time slot (offered) and/or confirmed one (confirmed). */
export function detectSlotOffer<T extends { text: string; line: number }>(sentences: T[]): { offered?: T; confirmed?: T } {
  const offered = sentences.find((s) => SLOT_TIME_RE.test(s.text) && SLOT_OFFER_RE.test(s.text));
  const confirmed = offered ? sentences.find((s) => SLOT_TIME_RE.test(s.text) && SLOT_CONFIRM_RE.test(s.text)) : undefined;
  return { offered, confirmed };
}

interface Sentence {
  line: number; // 1-based transcript position
  turn: number; // index among trainee turns
  text: string;
}

function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 1);
}

/** Share of trainee words that repeat earlier words; high values indicate padding/stuffing. */
function repetitionPenalty(sentences: Sentence[]): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const s of sentences) {
    const k = norm(s.text).replace(/[^a-z0-9 ]/g, "");
    if (seen.has(k)) dupes++;
    seen.add(k);
  }
  const words = sentences.flatMap((s) => norm(s.text).replace(/[^a-z0-9' ]/g, " ").split(" ").filter(Boolean));
  const diversity = words.length >= 12 ? new Set(words).size / words.length : 1;
  const dupShare = sentences.length ? dupes / sentences.length : 0;
  // 0 (clean) .. 1 (heavily repetitive)
  return Math.min(1, dupShare * 1.2 + (diversity < 0.6 ? (0.6 - diversity) * 1.5 : 0));
}

/** Deterministic keyword-coverage grader used when no LLM key is configured. */
export function gradeHeuristically(scenario: Scenario, turns: Turn[], note?: string): Evaluation {
  const rubric = normalizeWeights(scenario.rubric);
  const sentences: Sentence[] = [];
  let turnNo = 0;
  // Line numbers index the transcript as given (system and blank turns included) so the debrief's T-numbers match.
  turns.forEach((t, i) => {
    if (t.role !== "user" || !t.text.trim()) return;
    for (const text of splitSentences(t.text)) sentences.push({ line: i + 1, turn: turnNo, text });
    turnNo++;
  });
  const rep = repetitionPenalty(sentences);
  const slot = detectSlotOffer(sentences);

  const criteria: CriterionResult[] = rubric.map((c) => {
    const kws = keywordsOf(`${c.name} ${c.description}`);
    const res = kws.map(wordRe);
    // Each keyword is credited once, to the first sentence that uses it, and a
    // single sentence can earn at most MAX_HITS_PER_SENTENCE credits.
    const credit = new Map<Sentence, number>();
    let credited = 0;
    const turnsHit = new Set<number>();
    res.forEach((re) => {
      const s = sentences.find((x) => re.test(x.text) && (credit.get(x) ?? 0) < MAX_HITS_PER_SENTENCE);
      if (!s) return;
      credit.set(s, (credit.get(s) ?? 0) + 1);
      turnsHit.add(s.turn);
      credited++;
    });
    let coverage = kws.length ? credited / kws.length : 0;
    // Real coverage shows up across the conversation, not in one burst.
    if (credited > 1 && turnsHit.size < 2) coverage *= 0.6;

    let bonus = 0;
    const evidenceSentences = [...credit.entries()].sort((a, b) => b[1] - a[1] || a[0].line - b[0].line).map(([s]) => s);
    if (/greet|rapport|opening|intro/i.test(`${c.id} ${c.name}`)) {
      const g = sentences.filter((s) => s.turn < 2 && GREETING_RE.test(s.text));
      if (g.length) {
        bonus += 30;
        // Quote the actual greeting, not whichever fragment happened to share a keyword.
        evidenceSentences.splice(0, evidenceSentences.length, ...g.slice(0, 2));
      }
    }
    if (/discover|question|clarif|listen/i.test(`${c.id} ${c.name}`)) {
      bonus += Math.min(15, 5 * sentences.filter((s) => s.text.includes("?")).length);
    }
    // Keyword overlap misses "I'm sorry", so a criterion that asks for an apology credits a real one
    // (the same detector as the live coach), and less when the rep keeps apologizing.
    let apologyNote = "";
    if (APOLOGY_STEP_RE.test(`${c.name}. ${c.description}`)) {
      const sorry = sentences.filter((s) => isApology(s.text));
      if (sorry.length) {
        bonus += sorry.length <= 2 ? 25 : 10;
        evidenceSentences.unshift(sorry[0]);
        const points = `addressed ${Math.min(credited, kws.length)} of ${kws.length} expected points for this area`;
        apologyNote = sorry.length <= 2 ? `You apologized plainly and ${points}.` : `You apologized ${sorry.length} times; once, plainly, lands better. You ${points}.`;
      }
    }
    const raw = 20 + coverage * 80 + bonus;
    let score = sentences.length === 0 ? 0 : Math.max(0, Math.min(100, Math.round(raw * (1 - 0.4 * rep))));
    // Offering a concrete slot earns partial booking/closing credit; confirming it earns more.
    let slotNote = "";
    if (BOOKING_CRITERION_RE.test(`${c.id} ${c.name}`) && slot.offered) {
      const floor = slot.confirmed ? 80 : 60;
      if (score < floor) score = floor;
      const s = slot.confirmed ?? slot.offered;
      evidenceSentences.unshift(s);
      slotNote = slot.confirmed ? "You offered a concrete slot and confirmed it." : "You offered a concrete appointment slot (not yet confirmed), which earns partial credit.";
    }
    const seenLines = new Set<number>();
    const evidence = evidenceSentences
      .filter((s) => !seenLines.has(s.line) && seenLines.add(s.line))
      .slice(0, 2)
      .map((s) => ({ speaker: "trainee" as const, quote: s.text.length > 220 ? `${s.text.slice(0, 217)}...` : s.text, line: s.line }));
    return {
      id: c.id,
      name: c.name,
      weight: c.weight,
      score,
      rationale: slotNote || apologyNote || (evidence.length
        ? `You addressed ${Math.min(credited, kws.length)} of ${kws.length} expected points for this area${rep > 0.3 ? ", but repeated yourself a lot" : ""}.`
        : "Nothing you said clearly addressed this area."),
      evidence,
    };
  });
  const overallScore = weightedOverall(criteria);
  const goalStatus: GoalStatus = overallScore >= 70 || (slot.confirmed && overallScore >= 60) ? "achieved" : overallScore >= 45 || slot.offered ? "partial" : "not_achieved";
  const weak = criteria.filter((c) => c.score < 60);
  const strong = criteria.filter((c) => c.score >= 75);
  return {
    method: "heuristic",
    graderVersion: GRADER_VERSIONS.heuristic,
    overallScore,
    grade: gradeFor(overallScore),
    summary: `Automatic estimate: ${overallScore}/100, based on how many of the rubric's topics you covered.`,
    criteria,
    strengths: strong.map((c) => `You covered ${c.name} well.`),
    improvements: weak.map((c) => `You could cover ${c.name} more clearly and completely.`),
    goalAchievement: {
      achieved: goalStatus === "achieved",
      status: goalStatus,
      explanation: `Your goal was: ${scenario.traineeGoal.replace(/[.!?\s]+$/, "")}. This status is estimated from your overall score.`,
    },
    note: note ?? "This is an automatic estimate that counts topic coverage. It can't judge tone or quality like AI grading can.",
  };
}

export async function evaluateCall(scenario: Scenario, turns: Turn[]): Promise<Evaluation> {
  if (!llmKey()) return gradeHeuristically(scenario, turns);
  try {
    return await gradeWithLlm(scenario, turns);
  } catch (e) {
    console.error("[grader] LLM grading failed, falling back to heuristic:", (e as Error).message);
    return gradeHeuristically(scenario, turns, "AI grading failed for this call, so this is a rules-based estimate. Re-grade with AI to try again.");
  }
}

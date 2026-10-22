import "server-only";
import { z } from "zod";
import { chat, extractJson } from "./llm";
import { llmKey } from "./serverConfig";
import { Scenario, normalizeWeights } from "./scenarios";

export interface Turn {
  role: "user" | "assistant" | "system";
  text: string;
}

import type { CriterionResult, Evaluation } from "./grader-types";
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
  goalAchieved: z.boolean(),
  goalExplanation: z.string().default(""),
});

async function gradeWithLlm(scenario: Scenario, turns: Turn[]): Promise<Evaluation> {
  const rubric = normalizeWeights(scenario.rubric);
  const system = [
    "You are an exacting sales/phone-call coach grading a trainee's practice call against a rubric.",
    "The TRAINEE is the human practising. The CALLER is an AI persona. Grade only the trainee.",
    "For EVERY rubric criterion give a 0-100 score, a one-or-two sentence rationale, and 1-3 evidence quotes.",
    "Evidence quotes MUST be copied verbatim from the transcript (a contiguous substring of one turn). Never invent or paraphrase. If there is no supporting evidence, return an empty evidence array and score low.",
    "Respond with JSON only: {summary, criteria:[{id, score, rationale, evidence:[{speaker:'trainee'|'caller', quote}]}], strengths:[], improvements:[], goalAchieved:boolean, goalExplanation}.",
  ].join("\n");
  const user = [
    `SCENARIO: ${scenario.title} (${scenario.industry})`,
    `TRAINEE GOAL: ${scenario.traineeGoal}`,
    `EXPECTED TALK TRACK:\n${scenario.callScript}`,
    `RUBRIC:\n${rubric.map((c) => `- id=${c.id} | ${c.name} (weight ${c.weight.toFixed(0)}%): ${c.description}`).join("\n")}`,
    `TRANSCRIPT:\n${formatTranscript(turns)}`,
  ].join("\n\n");

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
      rationale: r?.rationale ?? "The grader returned no assessment for this criterion.",
      evidence,
    };
  });
  const overallScore = weightedOverall(criteria);
  return {
    method: "llm",
    overallScore,
    grade: gradeFor(overallScore),
    summary: out.summary,
    criteria,
    strengths: out.strengths.slice(0, 5),
    improvements: out.improvements.slice(0, 5),
    goalAchievement: { achieved: out.goalAchieved, explanation: out.goalExplanation },
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
  const spoken = turns.filter((t) => t.role !== "system" && t.text.trim());
  const sentences: Sentence[] = [];
  let turnNo = 0;
  spoken.forEach((t, i) => {
    if (t.role !== "user") return;
    for (const text of splitSentences(t.text)) sentences.push({ line: i + 1, turn: turnNo, text });
    turnNo++;
  });
  const rep = repetitionPenalty(sentences);

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
    const raw = 20 + coverage * 80 + bonus;
    const score = sentences.length === 0 ? 0 : Math.max(0, Math.min(100, Math.round(raw * (1 - 0.4 * rep))));
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
      rationale: evidence.length
        ? `You addressed ${Math.min(credited, kws.length)} of ${kws.length} expected points for this area${rep > 0.3 ? ", but repeated yourself a lot" : ""}.`
        : "Nothing you said clearly addressed this area.",
      evidence,
    };
  });
  const overallScore = weightedOverall(criteria);
  const weak = criteria.filter((c) => c.score < 60);
  const strong = criteria.filter((c) => c.score >= 75);
  return {
    method: "heuristic",
    overallScore,
    grade: gradeFor(overallScore),
    summary: `Automatic estimate: ${overallScore}/100, based on how many of the rubric's topics you covered.`,
    criteria,
    strengths: strong.map((c) => `${c.name}: you covered this well.`),
    improvements: weak.map((c) => `${c.name}: ${rubric.find((r) => r.id === c.id)?.description || "bring this up more clearly."}`),
    goalAchievement: {
      achieved: overallScore >= 70,
      explanation: `Goal: ${scenario.traineeGoal} (estimated from your overall score).`,
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
    return gradeHeuristically(scenario, turns, "The LLM grader failed, so a keyword heuristic was used instead.");
  }
}

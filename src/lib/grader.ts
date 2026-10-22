import "server-only";
import { z } from "zod";
import { chat } from "./llm";
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
      score: z.number(),
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

  const out = LlmOutput.parse(JSON.parse(await chat([{ role: "system", content: system }, { role: "user", content: user }], { json: true })));
  const haystack = turns.map((t) => norm(t.text));

  const criteria: CriterionResult[] = rubric.map((c) => {
    const r = out.criteria.find((x) => x.id === c.id);
    const evidence = (r?.evidence ?? [])
      .filter((e) => e.quote.trim().length > 3 && haystack.some((h) => h.includes(norm(e.quote))))
      .slice(0, 3)
      .map((e) => ({ speaker: (e.speaker === "caller" ? "caller" : "trainee") as "trainee" | "caller", quote: e.quote.trim() }));
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

const STOP = new Set("the a an and or of to in on for with is are be your you their this that it as at by from about when what how any all".split(" "));
const stem = (w: string) => w.slice(0, 5);
const words = (s: string) => norm(s).replace(/[^a-z0-9' ]/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** Deterministic keyword-coverage grader used when no LLM key is configured. */
export function gradeHeuristically(scenario: Scenario, turns: Turn[], note?: string): Evaluation {
  const rubric = normalizeWeights(scenario.rubric);
  const trainee = turns.filter((t) => t.role === "user" && t.text.trim());
  const traineeStems = new Set(trainee.flatMap((t) => words(t.text).map(stem)));

  const criteria: CriterionResult[] = rubric.map((c) => {
    const kws = [...new Set(words(`${c.name} ${c.description}`).map(stem))];
    const hits = kws.filter((k) => traineeStems.has(k));
    const coverage = kws.length ? hits.length / kws.length : 0;
    let best: { text: string; n: number } | null = null;
    for (const t of trainee) {
      const ts = new Set(words(t.text).map(stem));
      const n = kws.filter((k) => ts.has(k)).length;
      if (n > 0 && (!best || n > best.n)) best = { text: t.text.trim(), n };
    }
    const questionBonus = /discover|question|clarif|listen/i.test(c.name) && trainee.some((t) => t.text.includes("?")) ? 10 : 0;
    const score = trainee.length === 0 ? 0 : Math.min(100, Math.round(25 + coverage * 85 + questionBonus));
    return {
      id: c.id,
      name: c.name,
      weight: c.weight,
      score,
      rationale: best
        ? `Keyword match: the trainee touched on ${hits.length} of ${kws.length} themes from this criterion (${hits.slice(0, 4).join(", ") || "none"}).`
        : "No trainee statement matched the themes of this criterion.",
      evidence: best ? [{ speaker: "trainee", quote: best.text.length > 220 ? `${best.text.slice(0, 217)}...` : best.text }] : [],
    };
  });
  const overallScore = weightedOverall(criteria);
  const weak = criteria.filter((c) => c.score < 60);
  const strong = criteria.filter((c) => c.score >= 75);
  return {
    method: "heuristic",
    overallScore,
    grade: gradeFor(overallScore),
    summary: `Heuristic score ${overallScore}/100 based on keyword coverage of the rubric. Configure an LLM key (LLM_API_KEY) for nuanced, quote-backed grading.`,
    criteria,
    strengths: strong.map((c) => `Covered: ${c.name}`),
    improvements: weak.map((c) => `Improve: ${c.name} (scored ${c.score})`),
    goalAchievement: {
      achieved: overallScore >= 70,
      explanation: `Goal: ${scenario.traineeGoal} (heuristic estimate from overall score).`,
    },
    note: note ?? "No LLM configured: this score is a deterministic keyword heuristic, not a judgement of call quality.",
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

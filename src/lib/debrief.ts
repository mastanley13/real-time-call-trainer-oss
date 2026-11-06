/** Pure helpers for the debrief: the next move, where to retry from, quote anchors, and which persona to drill next. */
import type { CriterionResult, Evaluation } from "./grader-types";
import { stripGraderNote } from "./grader-types";
import type { ObjectionType, Scenario } from "./scenarios";

type Turn = { role: string; text: string };

const STOP = new Set("the a an and or of to in on for with is are be your you their this that it as at by from about when what how any all can will has have was were not but if then them they her his its our out up per get gets got into also more most very just than so do does did clearly before after".split(" "));
const SYNONYMS: Record<string, string[]> = {
  price: ["cost", "fee", "pricing", "expensive", "budget", "afford", "pay", "quote", "rate"],
  pricing: ["cost", "fee", "price", "expensive", "budget", "afford", "pay", "quote"],
  fee: ["cost", "price", "charge", "pay"],
  objection: ["but", "worried", "concern", "not sure", "too"],
  booking: ["schedule", "appointment", "time", "today", "tomorrow", "window"],
  close: ["commit", "sign", "decide", "next step"],
  contract: ["term", "months", "commitment", "lock"],
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

function keywordsFor(name: string, description: string) {
  const base = words(`${name} ${description}`);
  const extra = base.flatMap((w) => SYNONYMS[w] ?? []);
  return [...new Set([...base, ...extra])];
}

/** The lowest-scoring criterion; the first one listed wins a tie. */
export function weakestCriterion(ev: Pick<Evaluation, "criteria">): CriterionResult | undefined {
  return [...ev.criteria].sort((a, b) => a.score - b.score)[0];
}

/** How the retry turn was picked: its text names the weak topic, it comes right before that criterion's evidence, or neither. */
type RetryBasis = "topic" | "evidence" | "fallback";

function findRetry(transcript: Turn[], ev: Evaluation): { idx: number; basis: RetryBasis; weakest: CriterionResult } | null {
  const weakest = weakestCriterion(ev);
  if (!weakest || transcript.length < 2) return null;
  const kws = keywordsFor(weakest.name, "");
  const callerIdx = transcript.map((t, i) => (t.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  if (!callerIdx.length) return null;
  const topical = callerIdx.find((i) => i > 0 && kws.some((k) => transcript[i].text.toLowerCase().includes(k)));
  if (topical !== undefined) return { idx: topical, basis: "topic", weakest };
  const evidenceLine = weakest.evidence[0]?.line;
  const beforeEvidence = evidenceLine ? [...callerIdx].reverse().find((i) => i < evidenceLine - 1) : undefined;
  if (beforeEvidence !== undefined) return { idx: beforeEvidence, basis: "evidence", weakest };
  return { idx: callerIdx[Math.min(1, callerIdx.length - 1)], basis: "fallback", weakest };
}

/**
 * The 1-based caller turn to restart from so the rep can redo the weakest moment:
 * the first persona line that touches the weakest criterion's topic, else the persona
 * line just before that criterion's best evidence, else the persona's second line.
 */
export function retryPoint(transcript: Turn[], ev: Evaluation): { turn: number; criterion: string; score: number } | null {
  const r = findRetry(transcript, ev);
  return r && { turn: r.idx + 1, criterion: r.weakest.name, score: r.weakest.score };
}

/**
 * The existing retry route: the trainer reloads this call, replays it up to `turn` and resumes after that caller line.
 * The persona id lets the trainer open the right buyer even when the call itself can't be loaded there.
 */
export function retryHref(sessionId: string, turn: number, scenarioId?: string): string {
  return `/trainer?retry=${encodeURIComponent(sessionId)}&turn=${turn}${scenarioId ? `&scenario=${encodeURIComponent(scenarioId)}` : ""}`;
}

/** Older heuristic sessions stored keyword-stem rationales; never show those to users. */
export function plainRationale(raw: string): string {
  const r = stripGraderNote(raw);
  return /^Keyword match:/.test(r) ? r.replace(/^Keyword match: the trainee touched on (\d+) of (\d+) themes from this criterion.*$/, "You addressed $1 of $2 expected points for this area.") : r;
}

/** The grade's summary, with the legacy heuristic wording replaced by a plain sentence. */
export function plainSummary(ev: Pick<Evaluation, "summary" | "overallScore">): string {
  return /^Heuristic score/.test(ev.summary) ? `Automatic estimate: ${ev.overallScore}/100, based on how many of the rubric's topics you covered.` : ev.summary;
}

/**
 * Where a grader quote sits in the transcript. "exact": the cited turn contains the quote word for word (the rules-based
 * grader shortens long sentences with a trailing "...", so that excerpt counts). "inexact": the grader cited a turn, but
 * the wording differs from it. "unmatched": no cited turn, or the cited turn is not in this transcript.
 */
export type QuoteAnchor = { status: "exact" | "inexact"; line: number } | { status: "unmatched" };

export function anchorQuote(transcript: Turn[], e: { quote: string; line?: number }): QuoteAnchor {
  const turn = e.line && e.line >= 1 ? transcript[e.line - 1] : undefined;
  if (!e.line || !turn) return { status: "unmatched" };
  const q = e.quote.trim();
  const head = q.endsWith("...") ? q.slice(0, -3).trimEnd() : q;
  return { status: head && turn.text.includes(head) ? "exact" : "inexact", line: e.line };
}

/** The one improvement the debrief leads with. Every field comes from the stored grade, the transcript or the persona pack. */
export interface NextMove {
  criterionId: string;
  criterion: string;
  score: number;
  /** 1-based caller turn: the retry point. Undefined when the call has no caller line to restart from. */
  turn?: number;
  /** The caller's words at `turn`, exactly as stored. Only set when that line touches the weak topic or leads into its evidence. */
  buyerSaid?: string;
  /** The grader's own rationale for the weakest criterion. */
  whatHappened?: string;
  /** The persona pack's prep answer for the objection the buyer raised in `buyerSaid`. A suggestion, not part of the grade. */
  trySaying?: string;
}

/** Lowercase words with punctuation folded to spaces, for containment checks. */
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Content words (3+ letters, no stop words) for overlap checks. */
const contentWords = (s: string) => new Set(flat(s).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));

/**
 * The persona objection the buyer's line actually raises, matched on the words, never on the rubric's topic.
 * Confident only when exactly one objection's line appears in the buyer's line (the scripted caller says it verbatim),
 * or, failing that, exactly one objection shares at least 2 and at least 60% of its content words with it. Anything
 * else, a paraphrase too loose to tell or two objections that fit, is no match.
 */
export function matchObjection<O extends { line: string }>(buyerLine: string, objections: readonly O[]): O | undefined {
  const said = flat(buyerLine);
  const heard = contentWords(buyerLine);
  const contained = objections.filter((o) => flat(o.line) && said.includes(flat(o.line)));
  if (contained.length) return contained.length === 1 ? contained[0] : undefined;
  const close = objections.filter((o) => {
    const want = [...contentWords(o.line)];
    const hit = want.filter((w) => heard.has(w)).length;
    return hit >= 2 && hit / want.length >= 0.6;
  });
  return close.length === 1 ? close[0] : undefined;
}

export function nextMove(transcript: Turn[], ev: Evaluation, scenario?: Pick<Scenario, "objections">): NextMove | null {
  const weakest = weakestCriterion(ev);
  if (!weakest) return null;
  const r = findRetry(transcript, ev);
  const buyer = r && r.basis !== "fallback" ? transcript[r.idx].text : "";
  const why = plainRationale(weakest.rationale);
  // The suggestion answers what the buyer said at this turn, so it needs that line and a confident match to it.
  const prep = buyer.trim() && scenario ? matchObjection(buyer, scenario.objections)?.prepAnswer.trim() : undefined;
  return {
    criterionId: weakest.id,
    criterion: weakest.name,
    score: weakest.score,
    ...(r ? { turn: r.idx + 1 } : {}),
    ...(buyer.trim() ? { buyerSaid: buyer } : {}),
    ...(why ? { whatHappened: why } : {}),
    ...(prep ? { trySaying: prep } : {}),
  };
}

/**
 * True when no quote in the grade matches its cited turn word for word, so no score on the page is backed by verified
 * evidence. Quotes whose wording differs, or that cite no turn in this transcript, don't count.
 */
export const lacksEvidence = (transcript: Turn[], ev: Pick<Evaluation, "criteria">): boolean =>
  !ev.criteria.some((c) => c.evidence.some((e) => anchorQuote(transcript, e).status === "exact"));

const TOPIC_TO_OBJECTION: [RegExp, ObjectionType][] = [
  [/price|pricing|fee|cost|value|budget/i, "price"],
  [/compet|compar/i, "competitor"],
  [/decision|authority|stakeholder|spouse/i, "authority"],
  [/trust|credib|rapport/i, "trust"],
  [/timing|urgency|contract/i, "timing"],
];

/** The objection type a criterion name is about, if any. */
const objectionTypeFor = (criterionName: string): ObjectionType | undefined => TOPIC_TO_OBJECTION.find(([re]) => re.test(criterionName))?.[1];

/** A different library persona that drills the weakest criterion's topic. */
export function nextDrill(library: Scenario[], current: { id?: string; role?: string }, weakestName: string): Scenario | undefined {
  const pool = library.filter((s) => s.id !== current.id);
  const type = objectionTypeFor(weakestName);
  const byObjection = type ? pool.filter((s) => s.objections.some((o) => o.type === type)) : [];
  const sameRole = byObjection.filter((s) => s.role === current.role);
  return sameRole[0] ?? byObjection.find((s) => s.status === "reviewed") ?? byObjection[0] ?? pool.find((s) => s.role === current.role) ?? pool[0];
}

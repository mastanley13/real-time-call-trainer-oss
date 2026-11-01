/**
 * Pure pass-rule evaluator for scripts/grade-regression.ts. No network, no keys, no server imports,
 * so tests/grade-regression.test.ts can run it on synthetic data.
 *
 * A candidate grader model may replace the baseline only when every rule passes:
 *  a) same letter grade as the baseline on at least 90% of fixtures, and never more than one letter apart;
 *  b) mean absolute difference of per-fixture mean scores at most 5 points;
 *  c) none of the weak "no contact asked" runs credit information capture;
 *  d) 100% of evidence quotes are verbatim in the transcript;
 *  e) the JSON parses (and validates) on 100% of runs;
 *  f) p95 grading latency at most baseline p95 + 20%.
 */

export const LETTERS = ["A", "B", "C", "D", "F"] as const;
export type Letter = (typeof LETTERS)[number];

/** Same cut-offs as gradeFor in src/lib/grader.ts. Kept here so this file stays free of server imports. */
export function letterFor(score: number): Letter {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

/** An information-capture score above this counts as crediting the trainee. Zero: a weak run that never asked for contact details gets no credit at all. */
export const INFO_CREDIT_THRESHOLD = 0;

export const MIN_LETTER_MATCH = 0.9;
export const MAX_MEAN_ABS_DIFF = 5;
export const LATENCY_SLACK = 0.2;

export interface FixtureRef {
  id: string;
  /** "weak_no_contact": the trainee never asked for contact details. Any info-capture credit is a failure (rule c). */
  kind: "weak_no_contact" | "name_only" | "contact_captured";
}

export interface RunResult {
  fixtureId: string;
  run: number;
  /** The model's JSON parsed and validated, so the grade is an AI grade and not the rules-based fallback. */
  parsed: boolean;
  score: number;
  infoCapture: number;
  /** Evidence quotes the model returned, and how many of them are contiguous substrings of the transcript. */
  quotesTotal: number;
  quotesVerbatim: number;
  /** False when the successful completion's raw evidence could not be read. Rule d then fails closed. */
  evidenceChecked: boolean;
  latencyMs: number;
}

export interface RuleResult {
  /** "base" is the precondition: a complete, fully parsed baseline and a complete candidate run set. */
  id: "base" | "a" | "b" | "c" | "d" | "e" | "f";
  name: string;
  pass: boolean;
  detail: string;
}

export interface FixtureSummary {
  fixtureId: string;
  baselineScore: number;
  baselineLetter: Letter;
  candidateScore: number;
  candidateLetter: Letter;
  letterDistance: number;
  absDiff: number;
}

export interface Evaluation {
  pass: boolean;
  rules: RuleResult[];
  fixtures: FixtureSummary[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Same normalisation as the grader's verbatim check. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

/** True when the quote is a contiguous substring of one transcript turn (case, spacing and curly quotes ignored). */
export function isVerbatim(quote: string, turns: { text: string }[]): boolean {
  const q = norm(quote);
  return q.length > 0 && turns.some((t) => norm(t.text).includes(q));
}

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

/** Fixtures that do not have exactly `expected` runs in `runs`. */
const incomplete = (fixtures: FixtureRef[], runs: RunResult[], expected: number) =>
  fixtures.filter((f) => runs.filter((r) => r.fixtureId === f.id).length !== expected).map((f) => f.id);

/**
 * `runsPerFixture` is how many gradings each fixture should have, for the baseline and for the candidate. A
 * comparison against a baseline that is missing runs or fell back to the rules-based grader proves nothing, so
 * it fails the "base" rule whatever the candidate scored.
 */
export function evaluateCandidate(fixtures: FixtureRef[], baseline: RunResult[], candidate: RunResult[], runsPerFixture: number): Evaluation {
  const byFixture = (runs: RunResult[], id: string) => runs.filter((r) => r.fixtureId === id);
  const baseMissing = incomplete(fixtures, baseline, runsPerFixture);
  const candMissing = incomplete(fixtures, candidate, runsPerFixture);
  const baseUnparsed = baseline.filter((r) => !r.parsed).length;
  const preconditionOk = fixtures.length > 0 && runsPerFixture > 0 && !baseMissing.length && !candMissing.length && baseUnparsed === 0;
  // Per fixture, compare the mean score of the runs that parsed. A model that never parses has no score to compare.
  const summaries: FixtureSummary[] = fixtures.map((f) => {
    const b = mean(byFixture(baseline, f.id).filter((r) => r.parsed).map((r) => r.score));
    const parsedCandidate = byFixture(candidate, f.id).filter((r) => r.parsed);
    const c = parsedCandidate.length ? mean(parsedCandidate.map((r) => r.score)) : 0;
    const bl = letterFor(b);
    const cl = letterFor(c);
    return {
      fixtureId: f.id,
      baselineScore: b,
      baselineLetter: bl,
      candidateScore: c,
      candidateLetter: cl,
      letterDistance: Math.abs(LETTERS.indexOf(bl) - LETTERS.indexOf(cl)),
      absDiff: Math.abs(b - c),
    };
  });

  const n = summaries.length;
  const same = summaries.filter((s) => s.letterDistance === 0).length;
  const worst = Math.max(0, ...summaries.map((s) => s.letterDistance));
  const meanDiff = mean(summaries.map((s) => s.absDiff));

  const weakIds = new Set(fixtures.filter((f) => f.kind === "weak_no_contact").map((f) => f.id));
  const weakRuns = candidate.filter((r) => weakIds.has(r.fixtureId) && r.parsed);
  const credited = weakRuns.filter((r) => r.infoCapture > INFO_CREDIT_THRESHOLD);

  const quotesTotal = candidate.reduce((a, r) => a + r.quotesTotal, 0);
  const quotesVerbatim = candidate.reduce((a, r) => a + r.quotesVerbatim, 0);
  const parsedRuns = candidate.filter((r) => r.parsed).length;
  const uninspected = candidate.filter((r) => r.parsed && !r.evidenceChecked).length;

  const baseP95 = percentile(baseline.map((r) => r.latencyMs), 95);
  const candP95 = percentile(candidate.map((r) => r.latencyMs), 95);
  const latencyLimit = baseP95 * (1 + LATENCY_SLACK);

  const rules: RuleResult[] = [
    {
      id: "base",
      name: "Baseline complete and parsed",
      pass: preconditionOk,
      detail: preconditionOk
        ? `${baseline.length} baseline and ${candidate.length} candidate runs, ${runsPerFixture} per fixture, every baseline run parsed`
        : [
            fixtures.length === 0 || runsPerFixture <= 0 ? "no fixtures or runs requested" : "",
            baseMissing.length ? `baseline is missing runs for ${baseMissing.join(", ")}` : "",
            candMissing.length ? `candidate is missing runs for ${candMissing.join(", ")}` : "",
            baseUnparsed ? `${baseUnparsed} of ${baseline.length} baseline runs did not parse (rules-based fallback)` : "",
          ].filter(Boolean).join("; "),
    },
    {
      id: "a",
      name: "Letter grade matches baseline",
      pass: n > 0 && same / n >= MIN_LETTER_MATCH && worst <= 1,
      detail: `${same} of ${n} fixtures (${pct(same, n)}) same letter, needs at least ${MIN_LETTER_MATCH * 100}%; furthest apart ${worst} letter${worst === 1 ? "" : "s"}, needs at most 1`,
    },
    {
      id: "b",
      name: "Mean absolute score difference",
      pass: n > 0 && meanDiff <= MAX_MEAN_ABS_DIFF,
      detail: `${meanDiff.toFixed(2)} points, needs at most ${MAX_MEAN_ABS_DIFF}`,
    },
    {
      id: "c",
      name: "No info-capture credit on weak runs",
      pass: weakRuns.length > 0 && credited.length === 0,
      detail: weakRuns.length ? `${credited.length} of ${weakRuns.length} weak runs scored information capture above ${INFO_CREDIT_THRESHOLD}, needs 0` : "no parsed weak runs to check, so this cannot pass",
    },
    {
      id: "d",
      name: "Evidence quotes verbatim",
      pass: quotesTotal > 0 && quotesVerbatim === quotesTotal && uninspected === 0,
      detail: uninspected
        ? `${uninspected} runs could not have their raw evidence inspected, so this cannot pass`
        : quotesTotal ? `${quotesVerbatim} of ${quotesTotal} quotes (${pct(quotesVerbatim, quotesTotal)}), needs 100%` : "the model returned no quotes, so this cannot pass",
    },
    {
      id: "e",
      name: "JSON parses",
      pass: candidate.length > 0 && parsedRuns === candidate.length,
      detail: `${parsedRuns} of ${candidate.length} runs (${pct(parsedRuns, candidate.length)}), needs 100%`,
    },
    {
      id: "f",
      name: "p95 latency",
      pass: baseP95 > 0 && candP95 <= latencyLimit,
      detail: `${Math.round(candP95)} ms against a limit of ${Math.round(latencyLimit)} ms (baseline p95 ${Math.round(baseP95)} ms plus ${LATENCY_SLACK * 100}%)`,
    },
  ];

  return { pass: rules.every((r) => r.pass), rules, fixtures: summaries };
}

/** The markdown report written to tally/grade-regression-<model>.md. */
export function renderReport(opts: { baselineModel: string; candidateModel: string; runsPerFixture: number; result: Evaluation; when: string }): string {
  const { baselineModel, candidateModel, runsPerFixture, result, when } = opts;
  const lines = [
    `# Grading regression: ${candidateModel} against ${baselineModel}`,
    "",
    `Run ${when}. ${runsPerFixture} runs per fixture per model. Verdict: **${result.pass ? "PASS" : "FAIL"}**.`,
    result.pass ? "This model may be recommended as LLM_MODEL_GRADE." : "This model must not become LLM_MODEL_GRADE.",
    "",
    "## Rules",
    "",
    "| Rule | Result | Detail |",
    "|---|---|---|",
    ...result.rules.map((r) => `| ${r.id}) ${r.name} | ${r.pass ? "pass" : "FAIL"} | ${r.detail} |`),
    "",
    "## Per fixture (mean of runs)",
    "",
    `| Fixture | ${baselineModel} | ${candidateModel} | Difference |`,
    "|---|---|---|---|",
    ...result.fixtures.map((f) => `| ${f.fixtureId} | ${f.baselineScore.toFixed(1)} ${f.baselineLetter} | ${f.candidateScore.toFixed(1)} ${f.candidateLetter} | ${f.absDiff.toFixed(1)} points, ${f.letterDistance} letter${f.letterDistance === 1 ? "" : "s"} |`),
    "",
  ];
  return lines.join("\n");
}

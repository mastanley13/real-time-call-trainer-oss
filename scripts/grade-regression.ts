/**
 * Grading regression for a candidate grader model. Run it by hand on a Preview with a Neon branch, never on prod.
 * It needs provider keys, so it is not part of CI or vitest.
 *
 *   npx tsx --conditions=react-server scripts/grade-regression.ts \
 *     --baseline claude-sonnet-5-5 --candidates gpt-6.1-terra,gpt-6-luna \
 *     --provider claude-sonnet-5-5=https://api.anthropic.com/v1,ANTHROPIC_KEY \
 *     --provider gpt-6.1-terra=https://api.openai.com/v1,OPENAI_API_KEY \
 *     --provider gpt-6-luna=https://api.openai.com/v1,OPENAI_API_KEY \
 *     --out /workspace/ct-launch/tally
 *
 * Flags
 *   --baseline <model>     The model that grades today. Default claude-sonnet-5-5.
 *   --candidates a,b,c     Models to test. Default gpt-6.1-terra,gpt-6-luna,claude-haiku-5-5 (VERIFY the Haiku id first).
 *   --provider m=url,ENV   Base URL and the NAME of the env var holding the key for model m (repeatable).
 *                          Without it a model uses LLM_BASE_URL_GRADE / LLM_API_KEY_GRADE, else LLM_BASE_URL / LLM_API_KEY.
 *   --runs <n>             Gradings per fixture per model. Default 3.
 *   --fixtures <dir>       Default tests/fixtures/grading.
 *   --out <dir>            Where grade-regression-<model>.md is written. Default tally.
 *
 * Each model grades through the real evaluateCall with LLM_MODEL_GRADE set to it, so the prompt, the schema check
 * and the verbatim-quote filter are the production ones. Keys and prompts are never printed.
 * Exit code 0 only when every candidate passes every rule in scripts/grade-regression-eval.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateCall, type Turn } from "../src/lib/grader";
import { extractJson } from "../src/lib/llm";
import { LIBRARY } from "../src/lib/personas";
import { BUILT_IN_SCENARIOS, type Scenario } from "../src/lib/scenarios";
import { evaluateCandidate, isVerbatim, renderReport, type FixtureRef, type RunResult } from "./grade-regression-eval";

interface Fixture extends FixtureRef {
  scenarioId: string;
  transcript: Turn[];
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flagAll = (name: string) => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));

function loadFixtures(dir: string): Fixture[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Fixture);
}

const providers = new Map<string, { base: string; keyEnv: string }>();
for (const spec of flagAll("provider")) {
  const m = /^([^=]+)=([^,]+),(.+)$/.exec(spec);
  if (!m) throw new Error(`Bad --provider "${spec}". Use model=baseUrl,KEY_ENV_NAME`);
  providers.set(m[1], { base: m[2], keyEnv: m[3] });
}

// Capture the model's raw JSON so evidence quotes can be checked before the grader filters them. Nothing is logged.
const captured: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await realFetch(input, init);
  if (String(input).endsWith("/chat/completions")) {
    res.clone().json().then((d) => {
      const raw = d?.choices?.[0]?.message?.content;
      captured.push(Array.isArray(raw) ? raw.map((p: { text?: string }) => p?.text ?? "").join("") : String(raw ?? ""));
    }).catch(() => {});
  }
  return res;
}) as typeof fetch;

function useModel(model: string) {
  process.env.LLM_MODEL_GRADE = model;
  const p = providers.get(model);
  if (p) {
    const key = process.env[p.keyEnv];
    if (!key) throw new Error(`Env var ${p.keyEnv} (key for ${model}) is not set.`);
    process.env.LLM_BASE_URL_GRADE = p.base;
    process.env.LLM_API_KEY_GRADE = key;
  }
}

async function gradeAll(model: string, fixtures: Fixture[], runs: number): Promise<RunResult[]> {
  useModel(model);
  const out: RunResult[] = [];
  for (const f of fixtures) {
    const scenario: Scenario | undefined = [...BUILT_IN_SCENARIOS, ...LIBRARY].find((s) => s.id === f.scenarioId);
    if (!scenario) throw new Error(`Fixture ${f.id}: unknown scenario ${f.scenarioId}`);
    for (let run = 1; run <= runs; run++) {
      captured.length = 0;
      const t0 = Date.now();
      const ev = await evaluateCall(scenario, f.transcript);
      const latencyMs = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 50)); // let the response clone finish reading
      let quotesTotal = 0;
      let quotesVerbatim = 0;
      try {
        const json = extractJson(captured[0] ?? "") as { criteria?: { evidence?: { quote?: unknown }[] }[] };
        for (const c of json.criteria ?? []) {
          for (const e of c.evidence ?? []) {
            if (typeof e.quote !== "string" || !e.quote.trim()) continue;
            quotesTotal++;
            if (isVerbatim(e.quote, f.transcript.filter((t) => t.role !== "system"))) quotesVerbatim++;
          }
        }
      } catch {
        /* an unparseable body is reported through `parsed` */
      }
      out.push({
        fixtureId: f.id,
        run,
        parsed: ev.method === "llm",
        score: ev.overallScore,
        infoCapture: ev.criteria.find((c) => c.id === "capture")?.score ?? 0,
        quotesTotal,
        quotesVerbatim,
        latencyMs,
      });
      console.log(`${model}  ${f.id}  run ${run}  ${ev.method === "llm" ? `${ev.overallScore} ${ev.grade}` : "FALLBACK"}  ${latencyMs} ms`);
    }
  }
  return out;
}

async function main() {
  const baselineModel = flag("baseline") ?? "claude-sonnet-5-5";
  const candidates = (flag("candidates") ?? "gpt-6.1-terra,gpt-6-luna,claude-haiku-5-5").split(",").map((s) => s.trim()).filter(Boolean);
  const runs = Number(flag("runs") ?? 3);
  const fixtureDir = flag("fixtures") ?? "tests/fixtures/grading";
  const outDir = flag("out") ?? "tally";
  const fixtures = loadFixtures(fixtureDir);
  if (!fixtures.length) throw new Error(`No fixtures in ${fixtureDir}. See its README.md.`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Baseline ${baselineModel}, candidates ${candidates.join(", ")}, ${fixtures.length} fixtures x ${runs} runs`);
  const baseline = await gradeAll(baselineModel, fixtures, runs);
  let allPass = true;
  for (const model of candidates) {
    const result = evaluateCandidate(fixtures, baseline, await gradeAll(model, fixtures, runs));
    allPass &&= result.pass;
    const file = path.join(outDir, `grade-regression-${model.replace(/[^\w.-]/g, "_")}.md`);
    fs.writeFileSync(file, renderReport({ baselineModel, candidateModel: model, runsPerFixture: runs, result, when: new Date().toISOString() }));
    console.log(`${model}: ${result.pass ? "PASS" : "FAIL"} -> ${file}`);
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(2);
});

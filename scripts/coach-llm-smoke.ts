/**
 * Live-coach smoke test against a real model. Needs a key, so run it by hand on a Preview, not in CI.
 *
 *   LLM_API_KEY=... LLM_MODEL_COACH=gpt-6-luna \
 *     npx tsx --conditions=react-server scripts/coach-llm-smoke.ts
 *
 * Replays three scripted text calls (fixtures from tests/fixtures/grading) turn by turn through the real
 * coachTurn, the way the browser does. Passes when every turn came from the model (source "llm", so the JSON
 * parsed and validated), every cue is valid, and p95 coach latency is at most 1.5 s. Nothing is printed
 * except turn numbers, sources and timings.
 */
import fs from "node:fs";
import path from "node:path";
import { coachTurn, type CoachTurnInput } from "../src/lib/coach";
import { CueSchema } from "../src/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "../src/lib/scenarios";
import { llmModelFor } from "../src/lib/serverConfig";
import { percentile } from "./grade-regression-eval";

const P95_LIMIT_MS = 1500;
const SIMS = ["tally-prism-60d", "tally-name-p1", "tally-weak-r1"];

async function main() {
  const dir = path.resolve(__dirname, "../tests/fixtures/grading");
  const latencies: number[] = [];
  const problems: string[] = [];
  console.log(`Coach model: ${llmModelFor("coach")}`);

  for (const id of SIMS) {
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as { scenarioId: string; transcript: CoachTurnInput[] };
    const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === fixture.scenarioId)!;
    const recent: string[] = [];
    for (let i = 1; i <= fixture.transcript.length; i++) {
      const r = await coachTurn(scenario, fixture.transcript.slice(0, i), { allowCue: true, recentCueKeys: [...recent] });
      if (r.cueKey) recent.push(r.cueKey);
      latencies.push(r.latencyMs);
      const cueOk = r.cue === null || CueSchema.safeParse(r.cue).success;
      if (r.source !== "llm") problems.push(`${id} turn ${i}: fell back to ${r.source}`);
      if (!cueOk) problems.push(`${id} turn ${i}: invalid cue`);
      console.log(`${id}  turn ${i}  ${r.source}  ${r.latencyMs} ms${r.cue ? "  cue" : ""}`);
    }
  }

  const p95 = percentile(latencies, 95);
  console.log(`p95 ${Math.round(p95)} ms over ${latencies.length} turns (limit ${P95_LIMIT_MS} ms)`);
  if (p95 > P95_LIMIT_MS) problems.push(`p95 ${Math.round(p95)} ms is over ${P95_LIMIT_MS} ms`);
  if (problems.length) {
    for (const p of problems) console.log(`FAIL  ${p}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(2);
});

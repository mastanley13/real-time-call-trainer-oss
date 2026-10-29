/**
 * Validates every persona pack in src/lib/personas (run: npm run validate:personas).
 * Errors fail the run (CI); warnings flag gaps that make the no-key demo weaker.
 */
import { ScenarioSchema, JOB_FAMILIES, BUILT_IN_SCENARIOS, type Scenario } from "../src/lib/scenarios";
import { LIBRARY } from "../src/lib/personas";

const HINTS: Record<string, RegExp> = {
  price: /\b(cost|fee|price|\$|expensive|pay|quote|afford)\b|\$/i,
  availability: /\b(today|tomorrow|afternoon|morning|works|schedule|show up|appointment|time)\b/i,
  objection: /\b(still|but|other|higher|budget|think|competitor|cheaper|too)\b/i,
  closing: /\b(thanks|thank you|great|sounds good|bye)\b/i,
};

const errors: string[] = [];
const warnings: string[] = [];
const ids = new Set<string>();
const builtInIds = new Set(BUILT_IN_SCENARIOS.map((s) => s.id));
const families = new Set<string>(JOB_FAMILIES.map((f) => f.id));

function check(s: Scenario) {
  const where = `${s.id}`;
  const parsed = ScenarioSchema.safeParse(s);
  if (!parsed.success) errors.push(`${where}: schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  if (ids.has(s.id)) errors.push(`${where}: duplicate id`);
  ids.add(s.id);
  if (!families.has(s.role)) errors.push(`${where}: role "${s.role}" is not a JOB_FAMILIES id`);
  const total = s.rubric.reduce((a, c) => a + c.weight, 0);
  if (total !== 100) errors.push(`${where}: rubric weights sum to ${total}, expected 100`);
  if (new Set(s.rubric.map((c) => c.id)).size !== s.rubric.length) errors.push(`${where}: duplicate rubric criterion ids`);
  if (!s.objections.length) errors.push(`${where}: needs at least one objection for the live coach`);
  for (const [i, o] of s.objections.entries()) if (!o.prepAnswer.trim()) warnings.push(`${where}: objection ${i + 1} has no prep answer`);
  if (!s.callScript.trim()) errors.push(`${where}: empty talk track`);
  if (!builtInIds.has(s.id)) {
    if (!s.id.startsWith(`${s.role}-`)) errors.push(`${where}: pack ids must start with the family id ("${s.role}-")`);
    if (s.sampleReplies.length < 4) warnings.push(`${where}: only ${s.sampleReplies.length} scripted replies (offline demo gets repetitive)`);
    for (const [hint, re] of Object.entries(HINTS)) if (!s.sampleReplies.some((r) => re.test(r))) warnings.push(`${where}: no scripted reply covers "${hint}"`);
  }
}

LIBRARY.forEach(check);
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(`${LIBRARY.length} personas checked: ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);

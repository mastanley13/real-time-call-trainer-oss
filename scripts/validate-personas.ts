/**
 * Validates every persona pack in src/lib/personas and the tenant's data packs (run: npm run validate:personas).
 * Errors fail the run (CI); warnings flag gaps that make the no-key demo weaker. The rules live in
 * src/lib/personaChecks.ts, which the tenant prebuild also runs.
 */
import { ALL_JOB_FAMILIES, BUILT_IN_SCENARIOS } from "../src/lib/scenarios";
import { ALL_PERSONAS, LIBRARY } from "../src/lib/personas";
import { personaProblems } from "../src/lib/personaChecks";
import { tenant } from "../src/lib/tenant";

// Every persona this tenant carries (OSS packs and data packs), not only the filtered library.
const { errors, warnings } = personaProblems(ALL_PERSONAS, {
  // OSS families plus the tenant-declared ones (personas.customFamilies) for its data packs.
  families: new Set(ALL_JOB_FAMILIES.map((f) => f.id)),
  builtInIds: new Set(BUILT_IN_SCENARIOS.map((s) => s.id)),
});
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(`${ALL_PERSONAS.length} personas checked for tenant ${tenant.id} (${LIBRARY.length} in its library): ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);

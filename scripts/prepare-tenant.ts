/**
 * Prebuild: picks the tenant (TENANT_CONFIG_DIR, default tenants/calltrainer), validates and merges it, copies its
 * assets to public/tenant/ and writes src/generated/tenant.json and src/generated/tenant-personas.json.
 * Runs before dev, build, test, typecheck and validate:personas (see package.json), or by hand: npm run tenant.
 *
 * An invalid tenant fails with every problem listed and exit code 1. There is no fallback to the default brand.
 * Phase 2 loads the persona library from the files just written and runs the full persona rules (the same ones as
 * validate:personas) over every persona the tenant carries, plus the family filter, default persona and voice checks.
 * On failure the generated files are removed so nothing builds from a half-checked tenant.
 *
 * Every message is passed through redactSecrets, and no message quotes an env value or a JSON parser excerpt.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ZodError } from "zod";
import { formatIssues } from "../src/lib/tenant-schema";
import { libraryProblems, redactSecrets, resolveTenantDir, secretFindings } from "../src/lib/tenantBuild";

const ROOT = resolve(__dirname, "..");
const GENERATED = join(ROOT, "src", "generated");
const CONFIG_OUT = join(GENERATED, "tenant.json");
const PERSONAS_OUT = join(GENERATED, "tenant-personas.json");
const PUBLIC_TENANT = join(ROOT, "public", "tenant");

/** A printable message for any failure: zod issues without received values, then secret redaction. */
const describe = (e: unknown): string =>
  redactSecrets(e instanceof ZodError ? formatIssues(e) : e instanceof Error ? e.message : "unexpected error");

function fail(message: string): never {
  console.error(`tenant: ${redactSecrets(message)}`);
  for (const f of [CONFIG_OUT, PERSONAS_OUT]) if (existsSync(f)) rmSync(f);
  process.exit(1);
}

async function main() {
  let resolved;
  try {
    resolved = resolveTenantDir({ root: ROOT, dir: process.env.TENANT_CONFIG_DIR, env: process.env });
  } catch (e) {
    fail(describe(e));
  }
  const { config, personas, assets, warnings } = resolved;
  for (const w of warnings) console.warn(`tenant: warn ${redactSecrets(w)}`);

  const configJson = `${JSON.stringify(config, null, 2)}\n`;
  const personasJson = `${JSON.stringify(personas, null, 2)}\n`;
  const leaks = [...secretFindings(configJson), ...secretFindings(personasJson)];
  if (leaks.length) fail(`generated output failed the secret scan: ${leaks.join(", ")}`);

  mkdirSync(GENERATED, { recursive: true });
  writeFileSync(CONFIG_OUT, configJson);
  writeFileSync(PERSONAS_OUT, personasJson);

  // public/tenant/ is generated too (gitignored): it holds exactly the current tenant's referenced assets, written
  // from the bytes that were checked, so a file swapped after validation is never copied.
  mkdirSync(PUBLIC_TENANT, { recursive: true });
  const keep = new Set(assets.map((a) => a.name));
  for (const f of readdirSync(PUBLIC_TENANT)) if (!keep.has(f) && f !== ".gitkeep") rmSync(join(PUBLIC_TENANT, f), { recursive: true });
  for (const a of assets) writeFileSync(join(PUBLIC_TENANT, a.name), a.data);

  // Phase 2: these modules read the files written above.
  try {
    const { ALL_JOB_FAMILIES, BUILT_IN_SCENARIOS, DataPersonaSchema, JOB_FAMILIES } = await import("../src/lib/scenarios");
    // Parse each data pack persona here first, so a failure names the persona by position with sanitized messages.
    const packErrors = personas.flatMap((p, i) => {
      const r = DataPersonaSchema.safeParse(p);
      return r.success ? [] : [`data pack persona ${i + 1}: ${formatIssues(r.error)}`];
    });
    if (packErrors.length) fail(`tenant "${config.id}" is invalid:\n  - ${packErrors.join("\n  - ")}`);

    const { REALTIME_VOICES } = await import("../src/lib/realtime");
    const { ALL_PERSONAS, LIBRARY } = await import("../src/lib/personas");
    const { personaProblems } = await import("../src/lib/personaChecks");
    const checked = personaProblems(ALL_PERSONAS, {
      families: new Set(ALL_JOB_FAMILIES.map((f) => f.id)),
      builtInIds: new Set(BUILT_IN_SCENARIOS.map((s) => s.id)),
    });
    for (const w of checked.warnings) console.warn(`tenant: warn ${redactSecrets(w)}`);
    const problems = [
      ...checked.errors,
      ...libraryProblems(config, { ossFamilyIds: JOB_FAMILIES.map((f) => f.id), voices: REALTIME_VOICES, libraryIds: LIBRARY.map((s) => s.id) }),
    ];
    if (problems.length) fail(`tenant "${config.id}" is invalid:\n  - ${problems.join("\n  - ")}`);
    console.log(`tenant: ${config.id} (${LIBRARY.length} personas, ${assets.length} assets) -> src/generated/tenant.json`);
  } catch (e) {
    fail(describe(e));
  }
}

main();

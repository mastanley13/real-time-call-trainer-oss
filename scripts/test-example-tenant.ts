/**
 * Example-tenant gate (npm run test:example-tenant, and the tail of npm test). A branded tenant must pass the
 * no-model-ids rule, the tenant runtime, access-mode, config and hardening tests, and the persona validator.
 *
 * Steps, with TENANT_CONFIG_DIR=tenants/example: prepare the tenant, run those Vitest files, run the validator.
 * Then, whatever happened, prepare the default tenant again (TENANT_CONFIG_DIR removed), so the steps after
 * npm test (validate:personas, build) and local work see calltrainer.tech. Exits non-zero if any step failed.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const FILES = [
  "tests/no-model-labels.test.ts",
  "tests/tenant-runtime.test.ts",
  "tests/tenant-access-mode.test.ts",
  "tests/tenant-config.test.ts",
  "tests/tenant-hardening.test.ts",
];

function run(label: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  console.log(`\ntest:example-tenant: ${label}`);
  const r = spawnSync("npx", args, { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
}

const exampleEnv: NodeJS.ProcessEnv = { ...process.env, TENANT_CONFIG_DIR: "tenants/example" };
const defaultEnv: NodeJS.ProcessEnv = { ...process.env };
delete defaultEnv.TENANT_CONFIG_DIR;

let ok = run("prepare tenants/example", ["tsx", "scripts/prepare-tenant.ts"], exampleEnv);
if (ok) ok = run("vitest (example tenant)", ["vitest", "run", ...FILES], exampleEnv);
if (ok) ok = run("validate personas (example tenant)", ["tsx", "scripts/validate-personas.ts"], exampleEnv);
const restored = run("restore the default tenant", ["tsx", "scripts/prepare-tenant.ts"], defaultEnv);

if (!ok || !restored) {
  console.error(`\ntest:example-tenant: failed${restored ? "" : " (and the default tenant could not be restored; run npm run tenant)"}`);
  process.exit(1);
}
console.log("\ntest:example-tenant: passed, default tenant restored");

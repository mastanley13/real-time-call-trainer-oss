/**
 * One-off repair for SAL-1018: text (unmetered) sessions that settleStale billed as abandoned voice calls, and open
 * voice sessions that never connected.
 *
 * Dry run (the default; prints the planned actions and writes nothing):
 *   DATABASE_URL=... npx tsx scripts/usage-repair-text-billing.ts --entry <UsageEntry id> --close-session <TrainerSession id>
 * Apply (writes, only with the explicit flag):
 *   DATABASE_URL=... npx tsx scripts/usage-repair-text-billing.ts --entry <id> --entry <id> --close-session <id> --apply
 *
 * --entry <id>          (repeatable) A wrongly billed voice_call UsageEntry. It must be kind voice_call, its session must
 *                       have no allowance (a text or unmetered save), and it must not have been credited already. The same
 *                       minutes are credited back as a credit_manual ledger entry with an audit note naming the original
 *                       entry id and SAL-1018 (creditTextBillingRefund in src/lib/usage.ts). Safe to run again: an entry
 *                       already credited is skipped.
 * --close-session <id>  (repeatable) An open voice TrainerSession that never connected: allowance set, connectedAt null,
 *                       no heartbeat, endedAt null, connect window over. Closed as failed_connect with 0 billed and its
 *                       reservation released, through the same path settleStale uses (closeNeverConnectedCall).
 * --apply               Write the changes. Without it nothing is written.
 *
 * Every write goes through the ledger functions in src/lib/usage.ts; this script never updates counters itself.
 * Never run automatically: it is not in package.json scripts and CI does not run it.
 */
import Module from "node:module";

// src/lib/usage.ts imports "server-only", which throws outside Next.js; a no-op shim is registered before it loads
// (static imports would be hoisted above it), as in scripts/coach-smoke.ts.
const localRequire = Module.createRequire(__filename);
const serverOnlyPath = localRequire.resolve("server-only");
localRequire.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as unknown as NodeJS.Module;

const USAGE = "Usage: npx tsx scripts/usage-repair-text-billing.ts [--entry <UsageEntry id>]... [--close-session <TrainerSession id>]... [--apply]";

interface Args { entries: string[]; closeSessions: string[]; apply: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { entries: [], closeSessions: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value.`);
      return v.trim();
    };
    if (flag === "--entry") out.entries.push(value());
    else if (flag === "--close-session") out.closeSessions.push(value());
    else if (flag === "--apply" && inline === undefined) out.apply = true;
    else if (flag === "--help" || flag === "-h") { console.log(USAGE); process.exit(0); }
    else throw new Error(`Unknown argument: ${raw}`);
  }
  out.entries = [...new Set(out.entries)];
  out.closeSessions = [...new Set(out.closeSessions)];
  return out;
}

/** Refusals that mean a previous run already did the work: reported, but not a failure. */
const DONE_BEFORE = new Set(["already_credited", "already_ended"]);

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.entries.length === 0 && args.closeSessions.length === 0) {
    console.error("Nothing to do: pass at least one --entry or --close-session.");
    console.error(USAGE);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }

  const usage = await import("../src/lib/usage");
  const { prisma } = await import("../src/lib/db");

  const line = "=".repeat(72);
  console.log(line);
  console.log(args.apply
    ? `APPLY MODE (${usage.TEXT_BILLING_TICKET}): changes WILL be written to the database.`
    : `DRY RUN (${usage.TEXT_BILLING_TICKET}): nothing will be written. Add --apply to write these changes.`);
  console.log(line);

  let failed = 0;
  const now = new Date();
  try {
    for (const id of args.entries) {
      try {
        const plan = args.apply ? await usage.creditTextBillingRefund(id, now) : await usage.planTextBillingRefund(id);
        if (!plan.ok) {
          console.log(`SKIP   credit  entry=${id}  reason=${plan.error}`);
          if (!DONE_BEFORE.has(plan.error)) failed++;
          continue;
        }
        const verb = args.apply ? "DONE  " : "PLAN  ";
        const creditEntryId = (plan as { creditEntryId?: string }).creditEntryId;
        const credit = creditEntryId ? `  creditEntry=${creditEntryId}` : "";
        console.log(`${verb} credit  entry=${id}  user=${plan.userId}  session=${plan.trainerSessionId}  allowance=${plan.allowanceId}  minutes=${plan.minutes}${credit}`);
      } catch (e) {
        failed++;
        console.error(`ERROR  credit  entry=${id}  ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const id of args.closeSessions) {
      try {
        const plan = args.apply ? await usage.closeNeverConnectedCall(id, now) : await usage.planNeverConnectedClose(id, now);
        if (!plan.ok) {
          console.log(`SKIP   close   session=${id}  reason=${plan.error}`);
          if (!DONE_BEFORE.has(plan.error)) failed++;
          continue;
        }
        const verb = args.apply ? "DONE  " : "PLAN  ";
        const settlement = (plan as { settlement?: { endReason: string; billedMinutes: number } }).settlement;
        const billed = settlement ? `  endReason=${settlement.endReason}  billedMinutes=${settlement.billedMinutes}` : "  endReason=failed_connect  billedMinutes=0";
        console.log(`${verb} close   session=${id}  user=${plan.userId}  allowance=${plan.allowanceId}  reservedMinutes=${plan.reservedMinutes}${billed}`);
      } catch (e) {
        failed++;
        console.error(`ERROR  close   session=${id}  ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(line);
  console.log(`${args.apply ? "Applied" : "Dry run finished"}: ${args.entries.length} entr${args.entries.length === 1 ? "y" : "ies"}, ${args.closeSessions.length} session${args.closeSessions.length === 1 ? "" : "s"}, ${failed} not actionable.`);
  if (!args.apply) console.log("Nothing was written.");
  process.exit(failed > 0 ? 1 : 0);
}

void main();

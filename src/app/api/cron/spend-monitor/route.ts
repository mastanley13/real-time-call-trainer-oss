import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/serverConfig";
import { runSpendMonitor } from "@/lib/spendMonitor";

/**
 * Hourly OpenAI spend monitor (STR-691); see src/lib/spendMonitor.ts.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} only (constant-time compare), like /api/cron/purge-expired.
 * Vercel Cron sends that header itself when CRON_SECRET is set. Scheduled hourly in vercel.json.
 *
 * Without OPENAI_ADMIN_KEY, OPENAI_PROJECT_ID, SPEND_BUDGET_START or a database it answers
 * { status: "not_configured", missing: [...names] } and does nothing.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runSpendMonitor();
    return NextResponse.json({ ok: result.status !== "error", ...result }, { status: result.status === "error" ? 502 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Database failures land here. Error class only: Prisma messages can carry connection details.
    console.error("[cron/spend-monitor] failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ ok: false, status: "error", error: "monitor_failed" }, { status: 500 });
  }
}

// Allow POST too so it's easy to test from curl.
export const POST = GET;

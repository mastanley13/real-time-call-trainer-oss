import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getLlmStatus, type LlmOutcome } from "@/lib/llmStatus";
import { getCapabilities, productionGuard } from "@/lib/serverConfig";

const LLM_CHECK: Record<LlmOutcome | "none", string> = {
  ok: "ok",
  auth_failed: "error_auth",
  quota: "error_quota",
  error: "error",
  none: "configured_unverified",
};

export async function GET() {
  const caps = getCapabilities();
  const checks: Record<string, string> = {};
  let ok = true;

  if (caps.database) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = "ok";
    } catch {
      ok = false;
      checks.db = "error";
    }
  } else {
    checks.db = "not_configured";
    ok = caps.demoMode;
  }
  checks.jwtSecret = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? "ok" : "missing_or_weak";
  if (checks.jwtSecret !== "ok" && !caps.demoMode) ok = false;
  checks.elevenlabs = caps.elevenlabs ? "configured" : "not_configured";
  checks.realtime = caps.realtime ? "configured" : "not_configured";
  // Reflects the last real model call seen by this server instance (no probe here: this route is public and must not
  // spend tokens). The authenticated POST /api/llm/check runs a live probe. Does not change `ok` or the status code,
  // which uptime monitors read for database health.
  const llm = getLlmStatus();
  checks.llm = caps.llm ? LLM_CHECK[llm.last ?? "none"] : "not_configured";
  checks.llmLastCallAt = llm.at ?? "none";
  checks.demoMode = caps.demoMode ? "on" : "off";

  const guard = productionGuard(process.env);
  if (guard.problems.includes("demo_in_production")) {
    ok = false;
    checks.demoMode = "error_demo_in_production";
  }
  if (guard.problems.includes("database_missing")) {
    ok = false;
    checks.db = "error_not_configured";
  }

  return NextResponse.json({ ok, checks, timestamp: new Date().toISOString() }, { status: ok ? 200 : 503 });
}

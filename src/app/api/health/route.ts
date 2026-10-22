import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCapabilities } from "@/lib/serverConfig";

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
  checks.llm = caps.llm ? "configured" : "not_configured";
  checks.demoMode = caps.demoMode ? "on" : "off";

  return NextResponse.json({ ok, checks, timestamp: new Date().toISOString() }, { status: ok ? 200 : 503 });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifySessionToken } from "@/lib/auth";
import { cronAuthorized, getCapabilities } from "@/lib/serverConfig";

/**
 * Uptime check. The public answer is only { ok } (200, or 503 when a required
 * dependency is down), so it never reveals demo mode or which providers are set.
 * The per-dependency checks need `Authorization: Bearer ${CRON_SECRET}` or a
 * signed-in platform admin. The demo user never counts as an admin.
 */
async function canSeeDetails(req: NextRequest, demoMode: boolean, database: boolean): Promise<boolean> {
  const authorization = req.headers.get("authorization");
  if (cronAuthorized(authorization, process.env.CRON_SECRET)) return true;
  if (demoMode || !database) return false;
  const token = (/^bearer /i.test(authorization ?? "") ? authorization!.slice(7).trim() : "") || req.cookies.get("authToken")?.value;
  const session = token ? verifySessionToken(token) : null;
  if (!session) return false;
  try {
    const user = await prisma.user.findUnique({ where: { id: session.id }, select: { isPlatformAdmin: true } });
    return Boolean(user?.isPlatformAdmin);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
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
  const status = ok ? 200 : 503;
  const headers = { "Cache-Control": "no-store" };

  if (!(await canSeeDetails(req, caps.demoMode, caps.database))) return NextResponse.json({ ok }, { status, headers });

  checks.elevenlabs = caps.elevenlabs ? "configured" : "not_configured";
  checks.realtime = caps.realtime ? "configured" : "not_configured";
  checks.llm = caps.llm ? "configured" : "not_configured";
  checks.demoMode = caps.demoMode ? "on" : "off";
  return NextResponse.json({ ok, checks, timestamp: new Date().toISOString() }, { status, headers });
}

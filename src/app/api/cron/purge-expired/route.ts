import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { cronAuthorized } from "@/lib/serverConfig";

/**
 * Nightly purge of TrainerSession rows older than each organization's
 * configured retention window.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} only (constant-time compare). Vercel
 * Cron sends that header itself when CRON_SECRET is set. The x-vercel-cron header
 * is not trusted: any client can set it. Without CRON_SECRET the route always 401s.
 *
 * Assignment completion is derived from sessions, so a purged session can no longer
 * prove an assignment was done. loadAssignmentViews stops calling those assignments
 * overdue (see historyPurged in src/lib/team.ts) instead of flipping them back.
 *
 * Wire this up in vercel.json under "crons".
 */

const authorize = (req: NextRequest) => cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET);

async function runPurge() {
  const orgs = await prisma.organization.findMany({
    where: { sessionRetentionDays: { not: null } },
    select: { id: true, sessionRetentionDays: true },
  });

  const summary: Array<{
    organizationId: string;
    retentionDays: number;
    deletedCount: number;
  }> = [];
  let totalDeleted = 0;

  for (const org of orgs) {
    if (!org.sessionRetentionDays) continue;
    const cutoff = new Date(
      Date.now() - org.sessionRetentionDays * 24 * 60 * 60 * 1000,
    );
    const result = await prisma.trainerSession.deleteMany({
      where: {
        organizationId: org.id,
        createdAt: { lt: cutoff },
      },
    });
    summary.push({
      organizationId: org.id,
      retentionDays: org.sessionRetentionDays,
      deletedCount: result.count,
    });
    totalDeleted += result.count;
  }

  await prisma.auditEvent.create({
    data: {
      action: "system.retention_purge",
      metadata: {
        totalDeleted,
        orgs: summary,
      } satisfies Prisma.InputJsonValue,
    },
  });

  return { totalDeleted, orgs: summary };
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runPurge();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/purge-expired] error:", error);
    return NextResponse.json(
      { ok: false, error: "Purge failed" },
      { status: 500 },
    );
  }
}

// Allow POST too so it's easy to test from curl.
export const POST = GET;

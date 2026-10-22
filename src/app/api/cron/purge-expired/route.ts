import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Nightly purge of TrainerSession rows older than each organization's
 * configured retention window.
 *
 * Auth: either (a) the Vercel Cron "x-vercel-cron" header is present, or
 * (b) an Authorization: Bearer ${CRON_SECRET} header matches the env.
 *
 * Wire this up in vercel.json under "crons".
 */

function authorize(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron") === "1") return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  return auth.slice(7).trim() === secret;
}

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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { INVITE_PUBLIC_SELECT, generateInviteCode, hashInviteCode, inviteStatus, invitesConfigured, invitesNotConfigured } from "@/lib/invites";
import { clientIp, ipLimitResponse, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { requirePlatformAdmin } from "../_lib/server";

/**
 * Invite codes, platform admins only.
 *
 * GET   lists invites with their status. Never returns a code or a hash.
 * POST  creates one and returns the plain code once; only its hash is stored.
 */

const MAX_COUNT = 100_000;
const CreateSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    maxRedemptions: z.number().int().min(1).max(MAX_COUNT).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).max(40).nullable().optional(),
    minuteQuota: z.number().int().min(1).max(MAX_COUNT).nullable().optional(),
  })
  .strict();

type InviteRow = Prisma.InviteCodeGetPayload<{ select: typeof INVITE_PUBLIC_SELECT }>;
const toView = (row: InviteRow, now: Date) => ({
  ...row,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  status: inviteStatus(row, now),
});

const serverError = (what: string) =>
  NextResponse.json({ error: "server_error", message: `Could not ${what}. Try again in a minute.` }, { status: 500 });

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!invitesConfigured()) return invitesNotConfigured();
  try {
    const admin = await requirePlatformAdmin(auth);
    if (admin instanceof NextResponse) return admin;
    const rows = await prisma.inviteCode.findMany({ select: INVITE_PUBLIC_SELECT, orderBy: { createdAt: "desc" }, take: 500 });
    const now = new Date();
    return NextResponse.json({ invites: rows.map((r) => toView(r, now)) });
  } catch (error) {
    console.error("[/api/admin/invites] GET error:", error instanceof Error ? error.name : "unknown");
    return serverError("load invite codes");
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = ipLimitResponse(req, "invites") ?? userLimitResponse(auth.id, "inviteAdmin");
  if (limited) return limited;

  let body: z.infer<typeof CreateSchema>;
  try {
    const parsed = CreateSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return NextResponse.json(
        { error: "invalid_request", message: field ? `Check ${String(field)} and try again.` : "Give the invite a label." },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  const now = new Date();
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return NextResponse.json({ error: "invalid_expiry", message: "Pick an expiry date in the future." }, { status: 400 });
  }

  if (!invitesConfigured()) return invitesNotConfigured();

  try {
    const admin = await requirePlatformAdmin(auth);
    if (admin instanceof NextResponse) return admin;
    const code = generateInviteCode();
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.inviteCode.create({
        data: {
          codeHash: hashInviteCode(code),
          label: body.label,
          maxRedemptions: body.maxRedemptions ?? null,
          expiresAt,
          minuteQuota: body.minuteQuota ?? null,
          createdById: admin.id,
        },
        select: INVITE_PUBLIC_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          userId: admin.id,
          action: "invite.created",
          resource: created.id,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? undefined,
          metadata: { label: created.label, maxRedemptions: created.maxRedemptions, expiresAt: created.expiresAt?.toISOString() ?? null },
        },
      });
      return created;
    });
    // The only time the plain code leaves the server.
    return NextResponse.json({ invite: toView(row, now), code }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/invites] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("create the invite code");
  }
}

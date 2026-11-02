import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { invitesConfigured, invitesNotConfigured } from "@/lib/invites";
import { clientIp, ipLimitResponse, userLimitResponse } from "@/lib/rateLimit";
import { requirePlatformAdmin } from "../../_lib/server";

/**
 * DELETE revokes one invite code (platform admins only). The row is kept for
 * attribution: accounts made with it stay linked. Revoking stops new gate passes
 * and redemptions at once; gate cookies already issued for it lapse within
 * INVITE_ACCESS_MAX_AGE. Revoking twice is a no-op that keeps the first time.
 */

const IdParam = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = ipLimitResponse(req, "invites") ?? userLimitResponse(auth.id, "inviteAdmin");
  if (limited) return limited;

  const id = IdParam.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid_request", message: "That invite id isn't valid." }, { status: 400 });

  if (!invitesConfigured()) return invitesNotConfigured();

  try {
    const admin = await requirePlatformAdmin(auth);
    if (admin instanceof NextResponse) return admin;
    const now = new Date();
    const { count } = await prisma.inviteCode.updateMany({ where: { id: id.data, revokedAt: null }, data: { revokedAt: now } });
    const row = await prisma.inviteCode.findUnique({ where: { id: id.data }, select: { id: true, revokedAt: true } });
    if (!row) return NextResponse.json({ error: "not_found", message: "That invite code doesn't exist." }, { status: 404 });
    if (count === 1) {
      await prisma.auditEvent.create({
        data: { userId: admin.id, action: "invite.revoked", resource: row.id, ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? undefined },
      });
    }
    return NextResponse.json({ ok: true, id: row.id, revokedAt: row.revokedAt?.toISOString() ?? now.toISOString() });
  } catch (error) {
    console.error("[/api/admin/invites/[id]] DELETE error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "server_error", message: "Could not revoke the invite code. Try again in a minute." }, { status: 500 });
  }
}

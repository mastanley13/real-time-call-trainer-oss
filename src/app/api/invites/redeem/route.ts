import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { consumeInvite, hashInviteCode, invalidInvite, invitesConfigured, invitesNotConfigured, setInviteAccessCookie } from "@/lib/invites";
import { clientIp, ipLimitResponse, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";

/**
 * POST { code }: links the signed-in account to an invite code (attribution).
 * Takes one redemption atomically and refreshes the gate cookie for that invite.
 * New accounts redeem through /api/auth/register instead.
 */

const Body = z.object({ code: z.string().trim().min(1).max(200) });

class Refused extends Error {}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = ipLimitResponse(req, "access") ?? userLimitResponse(auth.id, "inviteRedeem");
  if (limited) return limited;

  let code: string;
  try {
    const parsed = Body.safeParse(await readJsonLimited(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request", message: "Enter an invite code." }, { status: 400 });
    code = parsed.data.code;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  if (!invitesConfigured()) return invitesNotConfigured();

  try {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { id: true, inviteCodeId: true } });
    if (!user) return NextResponse.json({ error: "unknown_user", message: "Sign in again and retry." }, { status: 401 });
    if (user.inviteCodeId) {
      return NextResponse.json({ error: "already_redeemed", message: "Your account is already linked to an invite code." }, { status: 409 });
    }
    const invite = await prisma.inviteCode.findUnique({ where: { codeHash: hashInviteCode(code) }, select: { id: true, expiresAt: true } });
    if (!invite) return invalidInvite();

    const now = new Date();
    try {
      await prisma.$transaction(async (tx) => {
        if (!(await consumeInvite(tx, invite.id, now))) throw new Refused("invalid");
        // Conditional too, so two redemptions racing for one account can't both count.
        const linked = await tx.user.updateMany({ where: { id: user.id, inviteCodeId: null }, data: { inviteCodeId: invite.id } });
        if (linked.count !== 1) throw new Refused("linked");
        await tx.auditEvent.create({
          data: { userId: user.id, action: "invite.redeemed", resource: invite.id, ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? undefined, metadata: { via: "link" } },
        });
      });
    } catch (e) {
      if (e instanceof Refused) {
        return e.message === "linked"
          ? NextResponse.json({ error: "already_redeemed", message: "Your account is already linked to an invite code." }, { status: 409 })
          : invalidInvite();
      }
      throw e;
    }

    const res = NextResponse.json({ ok: true, inviteId: invite.id });
    await setInviteAccessCookie(res, invite, now.getTime());
    return res;
  } catch (error) {
    console.error("[/api/invites/redeem] error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "server_error", message: "Could not redeem that code. Try again in a minute." }, { status: 500 });
  }
}

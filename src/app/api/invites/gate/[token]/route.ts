import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { accessCode } from "@/lib/access";
import { ipLimitResponse } from "@/lib/rateLimit";
import { INVITE_TOKEN_RE, inviteStatus } from "@/lib/invites";
import { INVITE_PASS_COOKIE, INVITE_PASS_TTL_MS, invitePassCookie, PASS_RETURN_FLAG, signInvitePass } from "@/lib/invitePass";
import { hashInviteToken } from "@/lib/inviteToken";
import { teamIsLocal } from "../../../team/_lib/server";

type Params = { params: Promise<{ token: string }> };

/**
 * GET: the database half of the access gate for team invites. The middleware sends an invite link here when the
 * visitor has no access code. An open invite (not accepted, revoked or expired) gets a signed pass cookie scoped
 * to finishing that invite and goes back to its page; anything else goes to /access, as before. Reachable without
 * the code, so it is rate limited per IP and says nothing beyond where to go next.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params;
  const valid = INVITE_TOKEN_RE.test(token);
  const to = (pathname: string, query: Record<string, string> = {}) => {
    const url = req.nextUrl.clone();
    url.pathname = pathname;
    url.search = "";
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return NextResponse.redirect(url, 303);
  };
  const toAccess = () => to("/access", valid ? { next: `/invite/${token}` } : {});

  // No gate, nothing to do.
  if (!accessCode()) return valid ? to(`/invite/${token}`) : to("/");
  const limited = ipLimitResponse(req, "invites");
  if (limited) return limited;
  // Demo and database-less installs cannot check an invite, so they keep the gate shut.
  if (!valid || teamIsLocal()) return toAccess();

  try {
    const invite = await prisma.teamInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: { id: true, tokenHash: true, expiresAt: true, acceptedAt: true, revokedAt: true },
    });
    const now = Date.now();
    if (!invite || inviteStatus(invite, new Date(now)) !== "pending") return toAccess();

    const expiresAt = Math.min(now + INVITE_PASS_TTL_MS, invite.expiresAt.getTime());
    const value = await signInvitePass({ inviteId: invite.id, tokenHash: invite.tokenHash, expiresAt });
    // No usable signing key: fail closed.
    if (!value) return toAccess();

    const res = to(`/invite/${token}`, { [PASS_RETURN_FLAG]: "1" });
    res.cookies.set(INVITE_PASS_COOKIE, value, invitePassCookie((expiresAt - now) / 1000));
    return res;
  } catch (error) {
    console.error("[/api/invites/gate] GET error:", error instanceof Error ? error.name : "unknown");
    return toAccess();
  }
}

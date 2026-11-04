import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { readJsonLimited } from "@/lib/rateLimit";
import { emailsMatch, inviteStatus, maskEmail, TokenBodySchema, type InvitePreview, type InviteRole } from "@/lib/invites";
import { hashInviteToken } from "@/lib/inviteToken";
import { gateAllowsInvite, passRequired } from "@/lib/invitePass";
import { SAMPLE_ORG } from "@/lib/teamSample";
import { teamIsLocal } from "../../team/_lib/server";
import { badRequest, invitesLimit, inviteLinkProblem, serverError } from "../../team/_lib/members";

/**
 * POST { token }: what the invite page shows a signed-in person before they accept. The token travels in the
 * body, not the URL, so it stays out of request logs. Signed-out visitors never reach this route.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  let token: string;
  try {
    const parsed = TokenBodySchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) return inviteLinkProblem("missing");
    token = parsed.data.token;
  } catch {
    return badRequest("The request body was not valid JSON.");
  }
  // Behind the access gate without the code, only the invite this request's pass was issued for.
  if (!(await gateAllowsInvite(req, token))) return passRequired();

  if (teamIsLocal()) {
    const preview: InvitePreview = { teamName: SAMPLE_ORG.name, role: "trainee", expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), emailMatches: true, alreadyMember: false, sample: true };
    return NextResponse.json(preview);
  }

  try {
    const invite = await prisma.teamInvite.findUnique({ where: { tokenHash: hashInviteToken(token) } });
    if (!invite) return inviteLinkProblem("missing");
    const status = inviteStatus(invite, new Date());
    if (status !== "pending") return inviteLinkProblem(status);

    const [user, org] = await Promise.all([
      prisma.user.findUnique({ where: { id: auth.id }, select: { email: true, organizationId: true } }),
      prisma.organization.findUnique({ where: { id: invite.organizationId }, select: { name: true } }),
    ]);
    if (!user) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!org) return inviteLinkProblem("missing");

    const matches = emailsMatch(user.email, invite.email);
    const preview: InvitePreview = {
      teamName: org.name,
      role: invite.role as InviteRole,
      expiresAt: invite.expiresAt.toISOString(),
      emailMatches: matches,
      ...(matches ? {} : { invitedEmail: maskEmail(invite.email) }),
      alreadyMember: user.organizationId === invite.organizationId,
    };
    return NextResponse.json(preview);
  } catch (error) {
    console.error("[/api/invites/preview] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("open the invite");
  }
}

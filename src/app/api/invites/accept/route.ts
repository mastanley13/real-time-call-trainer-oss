import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { signSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { grantAccessCookie } from "@/lib/access";
import { readJsonLimited } from "@/lib/rateLimit";
import { TokenBodySchema } from "@/lib/invites";
import { hashInviteToken } from "@/lib/inviteToken";
import { gateAllowsInvite, INVITE_PASS_COOKIE, invitePassCookie, passRequired } from "@/lib/invitePass";
import { SAMPLE_ORG } from "@/lib/teamSample";
import { teamIsLocal } from "../../team/_lib/server";
import { acceptInviteTx } from "../../team/_lib/acceptInvite";
import { badRequest, invitesLimit, inviteLinkProblem, seatsFull, serverError } from "../../team/_lib/members";

/**
 * POST { token }: the signed-in person joins the invite's organization with the invite's role (acceptInviteTx:
 * email match, single use, seat-checked under the organization lock). Answers with a fresh session (cookie and
 * token) that carries the new role. An accepted invite counts as site access, so with TRAINER_ACCESS_CODE set the
 * answer also carries the same access cookie that entering the code sets.
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

  if (teamIsLocal()) return NextResponse.json({ ok: true, team: { name: SAMPLE_ORG.name }, sample: true });

  try {
    const tokenHash = hashInviteToken(token);
    const result = await prisma.$transaction((tx) => acceptInviteTx(tx, auth.id, tokenHash));

    switch (result.kind) {
      case "link":
        return inviteLinkProblem(result.status);
      case "unknown_user":
        return NextResponse.json({ error: "Unknown user" }, { status: 401 });
      case "changed":
        return NextResponse.json({ error: "conflict", message: "Your team changed while this invite was being accepted. Reload the page and try again." }, { status: 409 });
      case "email_mismatch":
        return NextResponse.json({ error: "email_mismatch", message: `This invite is for ${result.invited}. Sign in with that email address to accept it.` }, { status: 403 });
      case "not_team_plan":
        return NextResponse.json({ error: "team_plan_required", message: "This team's plan no longer includes invites. Ask the team owner to check Billing." }, { status: 409 });
      case "already_member":
        return NextResponse.json({ error: "already_member", message: "You're already on this team." }, { status: 409 });
      case "sole_owner":
        return NextResponse.json({ error: "sole_owner", message: "You're the only owner of your current team, and it has other members. Make someone else an owner there first, then accept this invite." }, { status: 409 });
      case "seats_full":
        return seatsFull(result.seatCount);
    }

    const sessionUser = {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? undefined,
      lastName: result.user.lastName ?? undefined,
      role: result.user.role as "trainee" | "manager" | "owner",
    };
    const session = signSessionToken(sessionUser);
    const res = NextResponse.json({ ok: true, team: { name: result.org.name }, user: { ...sessionUser, isPlatformAdmin: result.user.isPlatformAdmin }, token: session });
    res.cookies.set("authToken", session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 12 });
    // The invite is accepted, so it now counts as site access (a no-op without the access gate).
    await grantAccessCookie(res);
    // The invite is used, so its pass has nothing left to open.
    res.cookies.set(INVITE_PASS_COOKIE, "", invitePassCookie(0));
    return res;
  } catch (error) {
    console.error("[/api/invites/accept] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("accept the invite");
  }
}

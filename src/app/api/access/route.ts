import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessCode, accessGateEnabled, accessToken, codeMatches, sharedCodeAllowed } from "@/lib/access";
import { prisma } from "@/lib/db";
import { hashInviteCode, inviteStatus, invitesConfigured, setInviteAccessCookie } from "@/lib/invites";
import { ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";

const Body = z.object({ code: z.string().max(200) });

const wrongCode = () =>
  NextResponse.json({ error: "invalid_code", message: "That code isn't right. Check it and try again." }, { status: 401 });

/**
 * Gate pass. Accepts the shared TRAINER_ACCESS_CODE while ALLOW_SHARED_ACCESS_CODE
 * allows it, or an active invite code (which is checked, not consumed; an
 * invite is used up when an account is created with it or linked to it).
 * One generic error for every failure, so the response says nothing about why.
 */
export async function POST(req: NextRequest) {
  const limited = ipLimitResponse(req, "access");
  if (limited) return limited;

  if (!accessGateEnabled()) return NextResponse.json({ ok: true });

  let input: string;
  try {
    const parsed = Body.safeParse(await readJsonLimited(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request", message: "Enter your access code." }, { status: 400 });
    input = parsed.data.code.trim();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }
  if (!input) return wrongCode();

  const code = accessCode();
  if (code && sharedCodeAllowed() && (await codeMatches(input, code))) {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ACCESS_COOKIE, await accessToken(code), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ACCESS_MAX_AGE,
    });
    return res;
  }

  if (!invitesConfigured()) return wrongCode();
  try {
    const invite = await prisma.inviteCode.findUnique({
      where: { codeHash: hashInviteCode(input) },
      select: { id: true, maxRedemptions: true, redemptionCount: true, expiresAt: true, revokedAt: true },
    });
    if (!invite || inviteStatus(invite) !== "active") return wrongCode();
    const res = NextResponse.json({ ok: true, invite: true });
    if (!(await setInviteAccessCookie(res, invite))) {
      return NextResponse.json({ error: "invites_not_configured", message: "Invite codes need JWT_SECRET on the server. Ask the admin to set it." }, { status: 503 });
    }
    return res;
  } catch (error) {
    console.error("[/api/access] invite lookup failed:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "server_error", message: "Could not check that code. Try again in a minute." }, { status: 500 });
  }
}

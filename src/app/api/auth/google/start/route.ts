import { NextRequest, NextResponse } from "next/server";
import { ipLimitResponse } from "@/lib/rateLimit";
import { authorizeUrl, flowCookieOptions, GOOGLE_FLOW_COOKIE, googleConfig, randomToken, safeNextPath, signFlowState } from "@/lib/googleAuth";
import { inviteTokenFromPath } from "@/lib/invites";
import { hasSiteAccess, passFrom, passMatchesToken } from "@/lib/invitePass";
import { parseSignupIntent } from "@/lib/signupIntent";

/**
 * Starts "Continue with Google". Optional query: next (a same-site path to land on) and the sign-up intent plan, interval, src and seg (whitelisted values only). The PKCE verifier, state and
 * nonce go into a signed, 10 minute, httpOnly cookie that the callback checks. 404 when Google sign-in is off.
 *
 * Behind the access gate without the code, a next of "/invite/<token>" also binds that invite into the signed flow,
 * but only when the browser holds the invite pass issued for that same token. The callback then accepts the invite
 * for a brand-new account before it grants site access.
 */
export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  if (!cfg) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const limited = ipLimitResponse(req, "google");
  if (limited) return limited;

  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  const inviteToken = inviteTokenFromPath(next);
  const pass = inviteToken && !(await hasSiteAccess(req)) ? await passFrom(req) : null;
  const invite = inviteToken && pass && (await passMatchesToken(pass, inviteToken)) ? inviteToken : undefined;

  const flow = {
    state: randomToken(),
    verifier: randomToken(48),
    nonce: randomToken(),
    next,
    intent: parseSignupIntent((k) => req.nextUrl.searchParams.get(k)),
    ...(invite ? { invite } : {}),
  };
  const res = NextResponse.redirect(authorizeUrl(cfg, flow));
  res.cookies.set(GOOGLE_FLOW_COOKIE, signFlowState(flow), flowCookieOptions());
  return res;
}

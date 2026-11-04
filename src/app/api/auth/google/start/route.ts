import { NextRequest, NextResponse } from "next/server";
import { ipLimitResponse } from "@/lib/rateLimit";
import { authorizeUrl, flowCookieOptions, GOOGLE_FLOW_COOKIE, googleConfig, randomToken, safeNextPath, signFlowState } from "@/lib/googleAuth";

/**
 * Starts "Continue with Google". Optional query: next (a same-site path to land on). The PKCE verifier, state and
 * nonce go into a signed, 10 minute, httpOnly cookie that the callback checks. 404 when Google sign-in is off.
 */
export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  if (!cfg) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const limited = ipLimitResponse(req, "google");
  if (limited) return limited;

  const flow = {
    state: randomToken(),
    verifier: randomToken(48),
    nonce: randomToken(),
    next: safeNextPath(req.nextUrl.searchParams.get("next")),
  };
  const res = NextResponse.redirect(authorizeUrl(cfg, flow));
  res.cookies.set(GOOGLE_FLOW_COOKIE, signFlowState(flow), flowCookieOptions());
  return res;
}

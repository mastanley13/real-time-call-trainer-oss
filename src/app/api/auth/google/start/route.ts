import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ipLimitResponse } from "@/lib/rateLimit";
import { authorizeUrl, flowCookieOptions, GOOGLE_FLOW_COOKIE, googleConfig, randomToken, safeNextPath, signFlowState } from "@/lib/googleAuth";

/**
 * Starts "Continue with Google". Optional query: next (same-site path),
 * code (org join code) and manager (a manager's id from an invite link).
 * Both carry through to the callback in a signed, 10 minute cookie.
 */
const Query = z.object({
  next: z.string().max(200).optional(),
  code: z.string().regex(/^[0-9]{3,8}$/).optional(),
  manager: z.string().trim().min(1).max(64).optional(),
  intent: z.enum(["solo", "team"]).optional(),
});

export async function GET(req: NextRequest) {
  const limited = ipLimitResponse(req, "google");
  if (limited) return limited;

  const cfg = googleConfig(req.nextUrl.origin);
  if (!cfg) {
    return NextResponse.json({ error: "google_not_configured", message: "Google sign-in isn't set up on this server. Sign in with email and password." }, { status: 503 });
  }

  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse({
    next: sp.get("next") ?? undefined,
    code: sp.get("code") || undefined,
    manager: sp.get("manager") || undefined,
    intent: sp.get("intent") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query", message: "The sign-in link is malformed. Go back and try again." }, { status: 400 });
  }

  const flow = {
    state: randomToken(),
    verifier: randomToken(48),
    nonce: randomToken(),
    next: safeNextPath(parsed.data.next),
    ...(parsed.data.code ? { joinCode: parsed.data.code } : {}),
    ...(parsed.data.intent ? { intent: parsed.data.intent } : {}),
    ...(parsed.data.code && parsed.data.manager ? { managerId: parsed.data.manager } : {}),
  };
  const res = NextResponse.redirect(authorizeUrl(cfg, flow));
  res.cookies.set(GOOGLE_FLOW_COOKIE, signFlowState(flow), flowCookieOptions);
  return res;
}

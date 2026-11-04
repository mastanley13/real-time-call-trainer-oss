import { NextRequest, NextResponse } from "next/server";
import { accessCode, hasValidAccessCookie } from "@/lib/access";
import { gateRouteToken, INVITE_PASS_COOKIE, invitePageToken, invitePassAllows, PASS_RETURN_FLAG, readInvitePass } from "@/lib/invitePass";
import { isPublicPath } from "@/lib/publicPaths";

/** Pages that stay readable without the access cookie. Exact matches only. */
const PUBLIC_PAGES = new Set(["/", "/privacy", "/terms"]);

/** Optional site-wide (cron routes authenticate with CRON_SECRET, the Stripe webhook with its signature) access gate, active only when TRAINER_ACCESS_CODE is set. */
export async function middleware(req: NextRequest) {
  const code = accessCode();
  if (!code) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PAGES.has(pathname) || pathname === "/access" || pathname === "/api/access" || pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/")) return NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await hasValidAccessCookie(req, code)) return NextResponse.next();

  // Team invites (see src/lib/invitePass.ts). The gate route checks a token against the database and, for an open
  // invite, sets a signed pass scoped to finishing that invite. The edge cannot reach the database, so it only
  // verifies the pass.
  if (gateRouteToken(pathname)) return NextResponse.next();
  const pass = await readInvitePass(req.cookies.get(INVITE_PASS_COOKIE)?.value);
  if (pass && (await invitePassAllows(pathname, pass))) return NextResponse.next();
  const inviteToken = invitePageToken(pathname);
  if (inviteToken && !req.nextUrl.searchParams.has(PASS_RETURN_FLAG)) {
    const url = req.nextUrl.clone();
    url.pathname = `/api/invites/gate/${inviteToken}`;
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access_code_required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  // Keep the query string so a link like /checkout/start?plan=pro&interval=year survives the access gate.
  // An invite page that fell through (its pass did not stick) goes back to the bare invite link after the code.
  url.searchParams.set("next", inviteToken ? pathname : pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and static assets (anything with a file extension).
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};

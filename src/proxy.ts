import { NextRequest, NextResponse } from "next/server";
import { accessCode, hasValidAccessCookie } from "@/lib/access";
import { isPublicPath } from "@/lib/publicPaths";

/** Pages that stay readable without the access cookie. Exact matches only. */
const PUBLIC_PAGES = new Set(["/", "/privacy", "/terms"]);

/** Optional site-wide (cron routes authenticate with CRON_SECRET, the Stripe webhook with its signature) access gate, active only when TRAINER_ACCESS_CODE is set. */
export async function proxy(req: NextRequest) {
  const code = accessCode();
  if (!code) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PAGES.has(pathname) || pathname === "/access" || pathname === "/api/access" || pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/")) return NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await hasValidAccessCookie(req, code)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access_code_required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  // Keep the query string so a link like /checkout/start?plan=pro&interval=year survives the access gate.
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and static assets (anything with a file extension).
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};

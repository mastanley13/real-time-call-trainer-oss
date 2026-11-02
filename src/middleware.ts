import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, accessGateEnabled, gateCookieValid } from "@/lib/access";
import { isPublicPath } from "@/lib/publicPaths";

/** Pages that stay readable without the access cookie. Exact matches only. */
const PUBLIC_PAGES = new Set(["/", "/privacy", "/terms"]);

/**
 * Optional site-wide access gate (cron routes authenticate with CRON_SECRET, the Stripe webhook with its signature).
 * Active when TRAINER_ACCESS_CODE is set or ALLOW_SHARED_ACCESS_CODE=false (invite-only). Passes with the
 * shared-code cookie while the shared code is allowed, or with a signed invite-code cookie.
 */
export async function middleware(req: NextRequest) {
  if (!accessGateEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PAGES.has(pathname) || pathname === "/access" || pathname === "/api/access" || pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/")) return NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();

  const cookie = req.cookies.get(ACCESS_COOKIE)?.value ?? "";
  if (await gateCookieValid(cookie)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access_code_required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals and static assets (anything with a file extension).
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};

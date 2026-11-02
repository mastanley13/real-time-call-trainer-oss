import { NextRequest, NextResponse } from "next/server";
import { accessCode, hasValidAccessCookie } from "@/lib/access";
import { isPublicPath } from "@/lib/publicPaths";
import { FT_COOKIE, FT_MAX_AGE, encodeTouchCookie, hasTouch, referrerHost, touchFromSearch } from "@/lib/firstTouch";

/** Pages that stay readable without the access cookie. Exact matches only. */
const PUBLIC_PAGES = new Set(["/", "/privacy", "/terms"]);

/** Optional site-wide (cron routes authenticate with CRON_SECRET, the Stripe webhook with its signature) access gate, active only when TRAINER_ACCESS_CODE is set. */
async function gate(req: NextRequest): Promise<NextResponse> {
  const code = accessCode();
  if (!code) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PAGES.has(pathname) || pathname === "/access" || pathname === "/api/access" || pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/")) return NextResponse.next();
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await hasValidAccessCookie(req, code)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access_code_required" }, { status: 401 });
  }
  // Keep the query string, so a tagged link comes back with its tags after the code is entered.
  // /access only follows a same-origin `next` (safeNextPath).
  const target = pathname + req.nextUrl.search;
  const url = req.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  url.searchParams.set("next", target);
  return NextResponse.redirect(url);
}

/** Stores the first touch (UTM tags, outside referrer host) on page loads. Never overwrites an existing ct_ft. */
function captureFirstTouch(req: NextRequest, res: NextResponse): void {
  if (req.nextUrl.pathname.startsWith("/api/") || req.cookies.has(FT_COOKIE)) return;
  const touch = { ...touchFromSearch(req.nextUrl.searchParams), referrer: referrerHost(req.headers.get("referer"), req.nextUrl.hostname) };
  if (!hasTouch(touch)) return;
  res.cookies.set(FT_COOKIE, encodeTouchCookie(touch), {
    // Not httpOnly: /register reads it to send the tags with sign-up. It holds sanitized tags only.
    secure: process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: FT_MAX_AGE,
  });
}

export async function middleware(req: NextRequest) {
  // Captured before the gate decides, so the /access redirect carries the cookie too.
  const res = await gate(req);
  captureFirstTouch(req, res);
  return res;
}

export const config = {
  // Skip Next internals and static assets (anything with a file extension).
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};

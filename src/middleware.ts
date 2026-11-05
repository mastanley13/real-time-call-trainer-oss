import { NextRequest, NextResponse } from "next/server";
import { accessCode, accessGate, hasValidAccessCookie } from "@/lib/access";
import { isGateExempt, isPublicPath } from "@/lib/publicPaths";
import { tenant } from "@/lib/tenant";

/**
 * Optional site-wide access gate (cron routes authenticate with CRON_SECRET, the Stripe webhook with its signature).
 * In access.mode "accounts" it is active only when TRAINER_ACCESS_CODE is set, as before. In "accounts_and_code" the
 * code is required: without it every path except /api/health and the machine callers is refused (fail closed).
 * Public paths are the tenant's subset of the OSS allowlist (src/lib/publicPaths.ts).
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const gate = accessGate(tenant.access.mode, accessCode());
  if (gate === "off") return NextResponse.next();

  if (gate === "misconfigured") {
    if (pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/")) return NextResponse.next();
    const message = "Sign-in is not set up on this deployment yet. Ask whoever runs it to set the access code.";
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "access_code_not_configured", message }, { status: 503 });
    return new NextResponse(message, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const code = gate.code;
  if (isGateExempt(pathname)) return NextResponse.next();
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

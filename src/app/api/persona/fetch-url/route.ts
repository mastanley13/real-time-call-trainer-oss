import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { FetchPageError, fetchPublicPage } from "@/lib/safeFetch";

// Uses node:dns for the SSRF checks.
export const runtime = "nodejs";

const Body = z.object({ url: z.string().trim().min(1).max(2048) });

/** Persona wizard "Product page" tab: fetches a public page and returns its readable text (FetchedPage). */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const ipLimited = ipLimitResponse(req, "wizard");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "wizard");
  if (userLimited) return userLimited;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Please enter a web address." }, { status: 400 });
  }

  try {
    return NextResponse.json(await fetchPublicPage(body.url));
  } catch (e) {
    if (!(e instanceof FetchPageError)) console.error("[/api/persona/fetch-url] error:", e);
    const message = e instanceof FetchPageError ? e.message : "We couldn't read that page. Paste the text instead.";
    return NextResponse.json({ error: "fetch_failed", message }, { status: 400 });
  }
}

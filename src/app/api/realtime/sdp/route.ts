import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { paidFeaturesGuard } from "@/lib/spendGuard";

const Body = z.object({
  // Only the short-lived ek_ secret minted by /api/realtime/session; printable ASCII so it cannot break the header.
  clientSecret: z.string().regex(/^ek_[!-~]{8,1000}$/),
  sdp: z.string().min(10).max(40_000),
});

/**
 * Relays the browser's WebRTC SDP offer to OpenAI and returns the answer.
 * This is the documented exchange (POST /v1/realtime/calls, "Authorization: Bearer ek_...",
 * "Content-Type: application/sdp"; https://developers.openai.com/api/docs/guides/realtime-webrtc)
 * made from the server so the page's CSP can keep connect-src to 'self'. Media still flows
 * browser <-> OpenAI directly; only this one signalling request passes through here.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const paused = paidFeaturesGuard();
  if (paused) return paused;

  const limit = rateLimit({ key: `realtime-sdp:${auth.id}`, limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited", message: "Too many connection attempts. Wait a minute, then start the call again." }, { status: 429 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_offer", message: "The browser sent an invalid connection offer. Reload the page and try again." }, { status: 400 });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.clientSecret}`, "Content-Type": "application/sdp" },
      body: body.sdp,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error("[realtime/sdp] upstream status", res.status);
      const expired = res.status === 401 || res.status === 403;
      return NextResponse.json(
        expired
          ? { error: "realtime_secret_expired", message: "The voice session expired before it connected. Start the call again." }
          : { error: "realtime_upstream_error", message: "OpenAI could not connect the voice call. Try again in a moment, or switch to Text." },
        { status: 502 },
      );
    }
    const sdp = await res.text();
    if (!sdp.trim()) throw new Error("empty SDP answer");
    return NextResponse.json({ sdp }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[realtime/sdp]", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to connect the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

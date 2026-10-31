import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { meteringEnabled } from "@/lib/serverConfig";
import { heartbeat } from "@/lib/usage";

// Only the call id and a state are read. Any times or durations the client adds are dropped by the schema.
const Body = z.object({
  callId: z.string().min(1).max(64),
  state: z.enum(["connected", "ok", "recovering"]),
});

/**
 * Client heartbeat for a metered voice call, every 10 seconds. "connected" (data channel open and first
 * remote audio arrived) fixes connectedAt on the server clock. The answer says whether the server has
 * stopped the call because the allowance ran out.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!meteringEnabled()) return NextResponse.json({ error: "metering_off" }, { status: 404 });

  const ipLimited = ipLimitResponse(req, "usage");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "usage");
  if (userLimited) return userLimited;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Heartbeat needs a call id and a state." }, { status: 400 });
  }

  const r = await heartbeat(auth.id, body.callId, body.state);
  if (!r.found) return NextResponse.json({ error: "not_found", message: "That call was not found." }, { status: 404 });
  if (r.stop) {
    return NextResponse.json({ stop: true, reason: r.reason, message: r.reason === "cap_reached" ? "You have used all your voice minutes for this period." : undefined });
  }
  return NextResponse.json({ stop: false, secondsLeft: r.secondsLeft });
}

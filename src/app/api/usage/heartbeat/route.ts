import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { meteringEnabled } from "@/lib/serverConfig";
import { heartbeat } from "@/lib/usage";
import { CAP_STOPPED_MESSAGE, FREE_CAP_STOPPED_MESSAGE, FREE_CAP_WARNING_MESSAGE } from "@/lib/billingUi";
import { queuePremiumEvent } from "@/lib/billingEvents";
import "@/lib/billing"; // registers the CRM sink that forwards voice_cap_hit

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
    // The allowance ran out during the call, on any plan (Free stops at its free minutes plus the end grace). Only the
    // stop itself says cap_reached; every heartbeat after it answers "ended", so this fires once per call. Ids only,
    // and never awaited.
    if (r.reason === "cap_reached") {
      queuePremiumEvent({ name: "voice_cap_hit", subject: "user", subjectId: auth.id, reason: "cap_reached_in_call" });
    }
    // A Free cap stop keeps its wording on the later "ended" answers too, for a client that missed the first one.
    const message = r.freeCap ? FREE_CAP_STOPPED_MESSAGE
      : r.reason === "cap_reached" ? CAP_STOPPED_MESSAGE
      : r.reason === "max_duration" ? "This call reached the maximum call length."
      : undefined;
    // freeCap: a Free call stopped at its free minutes. The client ends it through the hang-up path (see callMeter.ts).
    return NextResponse.json({ stop: true, reason: r.reason, message, ...(r.freeCap ? { freeCap: true } : {}) });
  }
  // capWarning: about a minute of a Free call's free minutes is left, worked out on the server and set on one heartbeat
  // per call (see heartbeat()). The client keeps its own once guard too (callMeter.ts).
  if (r.capWarning) return NextResponse.json({ stop: false, secondsLeft: r.secondsLeft, capWarning: true, message: FREE_CAP_WARNING_MESSAGE });
  return NextResponse.json({ stop: false, secondsLeft: r.secondsLeft });
}

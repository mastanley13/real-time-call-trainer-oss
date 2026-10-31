import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { meteringEnabled } from "@/lib/serverConfig";
import { endCall } from "@/lib/usage";
import { CLIENT_END_REASONS } from "@/lib/usagePlan";

// A client says why the call ended. It never says when or for how long: the server's clock decides what is billed.
const Body = z.object({
  callId: z.string().min(1).max(64),
  reason: z.enum(CLIENT_END_REASONS),
});

/** Ends and bills a voice call. Safe to repeat: a second end event returns the stored result and writes nothing. */
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
    return NextResponse.json({ error: "invalid_request", message: "Ending a call needs a call id and a reason." }, { status: 400 });
  }

  const result = await endCall(auth.id, body.callId, body.reason);
  if (!result) return NextResponse.json({ error: "not_found", message: "That call was not found." }, { status: 404 });
  return NextResponse.json(result);
}

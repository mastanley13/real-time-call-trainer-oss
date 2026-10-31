import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse } from "@/lib/rateLimit";
import { elevenLabsAgentFor, meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall } from "@/lib/usage";
import { capReached, minutesReserved } from "@/lib/usageResponses";

/**
 * Mints a short-lived WebRTC conversation token for the configured
 * ElevenLabs agent. The API key never leaves the server.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "token");
  if (ipLimited) return ipLimited;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: "elevenlabs_not_configured", message: "Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID." },
      { status: 503 },
    );
  }

  const limit = rateLimit({ key: `el-token:${auth.id}`, limit: 20, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  // Cap check before minting; the callId keys this call's metering. The persona id and title only label the call row.
  // Premium (the main agent) until its 60% share is used, then the standard agent for the next session.
  let callId: string | undefined;
  let maxSeconds: number | undefined;
  let mintAgentId = agentId;
  if (meteringEnabled()) {
    const q = req.nextUrl.searchParams;
    const begun = await beginCall(
      auth.id,
      { id: (q.get("scenarioId") || "unknown").slice(0, 80), title: q.get("title")?.slice(0, 120) || undefined },
      new Date(),
      { standardAvailable: elevenLabsAgentFor("standard").standardAvailable },
    );
    if (!begun.ok && begun.error === "cap_reached") return capReached();
    if (!begun.ok && begun.error === "minutes_reserved") return minutesReserved();
    if (begun.ok) {
      callId = begun.callId;
      maxSeconds = begun.maxSeconds;
      mintAgentId = elevenLabsAgentFor(begun.engine).agentId ?? agentId;
    }
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(mintAgentId)}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      console.error("[elevenlabs/token] upstream status", res.status);
      if (callId) await endCall(auth.id, callId, "failed_connect").catch(() => null);
      return NextResponse.json(
        { error: "elevenlabs_upstream_error", message: `ElevenLabs returned ${res.status}. Check your API key and agent id.` },
        { status: 502 },
      );
    }
    const { token } = await res.json();
    if (!token) throw new Error("no token in response");
    return NextResponse.json({ token, ...(callId ? { callId, maxSeconds } : {}) });
  } catch (e) {
    console.error("[elevenlabs/token]", e);
    if (callId) await endCall(auth.id, callId, "failed_connect").catch(() => null);
    return NextResponse.json({ error: "elevenlabs_upstream_error", message: "Could not reach ElevenLabs." }, { status: 502 });
  }
}

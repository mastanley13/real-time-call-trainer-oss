import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse } from "@/lib/rateLimit";
import { paidFeaturesGuard, paidFeaturesOffResponse, releaseRealtimeCall, reserveRealtimeCall } from "@/lib/spendGuard";
import { elevenLabsAgentFor, meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall } from "@/lib/usage";
import { capReached, minutesReserved, standardVoiceUnavailable, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";

/**
 * Mints a short-lived WebRTC conversation token for the configured
 * ElevenLabs agent. The API key never leaves the server.
 * Each token is one voice call, so it reserves minutes against the daily voice cap like a Realtime session.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const paused = await paidFeaturesGuard();
  if (paused) return paused;

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

  // Server-wide daily voice cap first (in memory, no database write), given back if the call is refused below or
  // ElevenLabs never mints the token.
  const reservation = reserveRealtimeCall();
  if (!reservation) return paidFeaturesOffResponse();
  const refuse = (response: Response) => {
    releaseRealtimeCall(reservation);
    return response;
  };

  // Cap check before minting; the callId keys this call's metering. The persona id and title only label the call row.
  // Premium (the main agent) until its 60% share is used, then the standard agent for the next session.
  let callId: string | undefined;
  let maxSeconds: number | undefined;
  let mintAgentId = agentId;
  if (meteringEnabled()) {
    const q = req.nextUrl.searchParams;
    // A failed lookup refuses voice (fail closed); text practice never reaches this route.
    const begun = await beginCall(
      auth.id,
      { id: (q.get("scenarioId") || "unknown").slice(0, 80), title: q.get("title")?.slice(0, 120) || undefined },
      new Date(),
      { standardAvailable: elevenLabsAgentFor("standard").standardAvailable },
    ).catch((e) => {
      console.error("[elevenlabs/token] usage lookup failed", e instanceof Error ? e.name : "unknown");
      return null;
    });
    if (!begun) return refuse(voiceUnavailable());
    if (!begun.ok && begun.error === "cap_reached") return refuse(capReached());
    if (!begun.ok && begun.error === "minutes_reserved") return refuse(minutesReserved());
    if (!begun.ok && begun.error === "voice_blocked") return refuse(voiceBlocked(begun.retryAfterSeconds));
    if (!begun.ok && begun.error === "standard_unavailable") return refuse(standardVoiceUnavailable());
    if (!begun.ok) return refuse(voiceUnavailable());
    callId = begun.callId;
    maxSeconds = begun.maxSeconds;
    mintAgentId = elevenLabsAgentFor(begun.engine).agentId ?? agentId;
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(mintAgentId)}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      console.error("[elevenlabs/token] upstream status", res.status);
      releaseRealtimeCall(reservation);
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
    releaseRealtimeCall(reservation);
    console.error("[elevenlabs/token]", e instanceof Error ? e.message : "unknown error");
    if (callId) await endCall(auth.id, callId, "failed_connect").catch(() => null);
    return NextResponse.json({ error: "elevenlabs_upstream_error", message: "Could not reach ElevenLabs." }, { status: 502 });
  }
}

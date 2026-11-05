import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse } from "@/lib/rateLimit";
import { elevenLabsAgentFor, meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall } from "@/lib/usage";
import { capReached, dailySessionLimit, minutesReserved, standardVoiceUnavailable, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";
import { emitPremiumEvent } from "@/lib/billingEvents";

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

  // `voiceTier=standard` is the rep's explicit request from the setup, resolved here for metered AND unmetered installs:
  // the call runs on the configured Standard agent, or is refused with standard_voice_not_configured when there is
  // none. It never falls back to the main (Premium) agent, and it is refused before any reservation is made. Any other
  // value lets the server decide as before (an unentitled Premium request is still Standard when metered).
  const q = req.nextUrl.searchParams;
  const chosenStandard = q.get("voiceTier") === "standard";
  const standardAgent = elevenLabsAgentFor("standard");
  if (chosenStandard && !standardAgent.standardAvailable) return standardVoiceUnavailable();

  // Cap check before minting; the callId keys this call's metering. The persona id and title only label the call row.
  // Premium (the main agent) while the add-on is entitled and Premium minutes are left, else the standard agent for
  // the next session. Never switched mid-call. Unmetered: the main agent, unless Standard was chosen.
  let callId: string | undefined;
  let maxSeconds: number | undefined;
  let mintAgentId = chosenStandard ? standardAgent.agentId ?? agentId : agentId;
  let voiceTier: "premium" | "standard" | undefined;
  let nextCallStandard = false;
  if (meteringEnabled()) {
    // A failed lookup refuses voice (fail closed); text practice never reaches this route.
    const begun = await beginCall(
      auth.id,
      { id: (q.get("scenarioId") || "unknown").slice(0, 80), title: q.get("title")?.slice(0, 120) || undefined },
      new Date(),
      // A chosen Standard call holds no paid Premium minutes.
      { standardAvailable: standardAgent.standardAvailable, preferStandard: chosenStandard },
    ).catch((e) => {
      console.error("[elevenlabs/token] usage lookup failed", e instanceof Error ? e.name : "unknown");
      return null;
    });
    if (!begun) return voiceUnavailable();
    if (!begun.ok && begun.error === "cap_reached") return capReached();
    if (!begun.ok && begun.error === "minutes_reserved") return minutesReserved();
    if (!begun.ok && begun.error === "voice_blocked") return voiceBlocked(begun.retryAfterSeconds);
    if (!begun.ok && begun.error === "daily_session_limit") return dailySessionLimit();
    if (!begun.ok && begun.error === "standard_unavailable") return standardVoiceUnavailable();
    if (!begun.ok) return voiceUnavailable();
    callId = begun.callId;
    maxSeconds = begun.maxSeconds;
    mintAgentId = elevenLabsAgentFor(begun.engine).agentId ?? agentId;
    voiceTier = begun.engine;
    nextCallStandard = begun.premium?.nextCallStandard ?? false;
    if (begun.premium?.fallback) {
      await emitPremiumEvent({ name: "premium_fallback_to_standard", subject: "user", subjectId: auth.id, reason: begun.premium.fallback });
    }
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(mintAgentId)}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      console.error("[elevenlabs/token] upstream status", res.status);
      if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
      return NextResponse.json(
        { error: "elevenlabs_upstream_error", message: `ElevenLabs returned ${res.status}. Check your API key and agent id.` },
        { status: 502 },
      );
    }
    const { token } = await res.json();
    if (!token) throw new Error("no token in response");
    // Metered calls also say which voice tier this call runs on (a label, never an agent or model id).
    return NextResponse.json({ token, ...(callId ? { callId, maxSeconds, ...(voiceTier ? { voiceTier, nextCallStandard } : {}) } : {}) });
  } catch (e) {
    console.error("[elevenlabs/token]", e);
    if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
    return NextResponse.json({ error: "elevenlabs_upstream_error", message: "Could not reach ElevenLabs." }, { status: 502 });
  }
}

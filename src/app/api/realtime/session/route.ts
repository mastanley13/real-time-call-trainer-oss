import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { meteringEnabled, realtimeModelFor } from "@/lib/serverConfig";
import { beginCall, type VoiceEngine } from "@/lib/usage";
import { capReached, dailySessionLimit, minutesReserved, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";
import { realtimeKey, realtimeVoice } from "@/lib/realtime";

const Body = z.object({ scenario: ScenarioSchema });

/**
 * Starts one practice call: the cap check and reservation, then the call id and the model and voice it will use.
 * It returns no OpenAI credential. The browser's WebRTC offer goes to /api/realtime/sdp, where the server opens the
 * provider call with its own API key, so it knows the provider call id and can hang the call up.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "realtime");
  if (ipLimited) return ipLimited;

  if (!realtimeKey()) {
    return NextResponse.json(
      { error: "realtime_not_configured", message: "Voice with OpenAI Realtime needs an OpenAI key. Set OPENAI_API_KEY on the server, or switch to Text." },
      { status: 503 },
    );
  }

  const limit = rateLimit({ key: `realtime:${auth.id}`, limit: 6, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited", message: "You started several calls in a row. Wait a minute, then try again." }, { status: 429 });
  }

  let scenario: z.infer<typeof Body>["scenario"];
  try {
    scenario = Body.parse(await readJsonLimited(req)).scenario;
  } catch {
    return NextResponse.json({ error: "invalid_scenario", message: "That persona could not be loaded for a voice call. Reload the page and try again." }, { status: 400 });
  }

  // Cap check before the call exists (rule 11). The returned callId keys every later metering write for this call.
  // The engine is chosen here, per session: Premium until its 60% share of the minutes is used, then standard
  // for the next session. A running call is never switched to another engine, but a Premium call may use only the
  // Premium minutes it reserved, so it ends when those run out (maxSeconds) and the next call starts on standard.
  let callId: string | undefined;
  let engine: VoiceEngine = "premium";
  let maxSeconds: number | undefined;
  if (meteringEnabled()) {
    // A failed lookup refuses voice (fail closed); text practice never reaches this route.
    // The validated persona is stored with the call: /api/realtime/sdp builds the provider session from this copy only.
    const begun = await beginCall(auth.id, scenario, new Date(), { providerSession: scenario as unknown as Prisma.InputJsonValue }).catch((e) => {
      console.error("[realtime/session] usage lookup failed", e instanceof Error ? e.name : "unknown");
      return null;
    });
    if (!begun) return voiceUnavailable();
    if (!begun.ok && begun.error === "cap_reached") return capReached();
    if (!begun.ok && begun.error === "minutes_reserved") return minutesReserved();
    if (!begun.ok && begun.error === "voice_blocked") return voiceBlocked(begun.retryAfterSeconds);
    if (!begun.ok && begun.error === "daily_session_limit") return dailySessionLimit();
    if (!begun.ok) return voiceUnavailable();
    callId = begun.callId;
    engine = begun.engine;
    maxSeconds = begun.maxSeconds;
  }

  const model = realtimeModelFor(engine);
  const voice = realtimeVoice(scenario.aiPersona.realtimeVoice);
  return NextResponse.json({ model, voice, ...(callId ? { callId, maxSeconds } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { meteringEnabled, realtimeModelFor } from "@/lib/serverConfig";
import { beginCall, endCall, type VoiceEngine } from "@/lib/usage";
import { capReached, minutesReserved, voiceBlocked } from "@/lib/usageResponses";
import { realtimeKey, realtimeTranscribeModel, realtimeUpstreamMessage, realtimeVoice } from "@/lib/realtime";

const Body = z.object({ scenario: ScenarioSchema });

/** The secret only has to outlive the SDP exchange; 600s is the documented default. */
const SECRET_TTL_SEC = 600;

/**
 * Mints a short-lived OpenAI Realtime client secret (ek_...) for one practice call.
 * The browser uses it to open a WebRTC session directly with OpenAI; the API key never leaves the server.
 * Docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "realtime");
  if (ipLimited) return ipLimited;

  const apiKey = realtimeKey();
  if (!apiKey) {
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

  // Cap check before minting (rule 11). The returned callId keys every later metering write for this call.
  // The engine is chosen here, per session: Premium until its 60% share of the minutes is used, then standard
  // for the next session. A call already running is never switched or ended.
  let callId: string | undefined;
  let engine: VoiceEngine = "premium";
  let maxSeconds = SECRET_TTL_SEC;
  if (meteringEnabled()) {
    const begun = await beginCall(auth.id, scenario);
    if (!begun.ok && begun.error === "cap_reached") return capReached();
    if (!begun.ok && begun.error === "minutes_reserved") return minutesReserved();
    if (!begun.ok && begun.error === "voice_blocked") return voiceBlocked(begun.retryAfterSeconds);
    if (begun.ok) {
      callId = begun.callId;
      engine = begun.engine;
      maxSeconds = begun.maxSeconds;
    }
  }

  const model = realtimeModelFor(engine);
  const voice = realtimeVoice(scenario.aiPersona.realtimeVoice);
  const session = {
    type: "realtime",
    model,
    // Same persona prompt as ElevenLabs and the text caller: stays in character and never coaches.
    instructions: buildAgentPrompt(scenario),
    output_modalities: ["audio"],
    audio: {
      input: {
        // Needed for the transcript, the live coach and grading: the realtime model itself never returns user text.
        transcription: { model: realtimeTranscribeModel() },
        // semantic_vad waits for a finished thought, so a trainee who pauses mid-pitch is not talked over.
        turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
        noise_reduction: { type: "near_field" },
      },
      output: { voice },
    },
  };

  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // The secret never outlives the call's reserved minutes. OpenAI only checks it while the session is
      // being set up, so this limits starting a late call, not a running one; billing is settled on the server.
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: Math.max(10, Math.min(SECRET_TTL_SEC, maxSeconds)) }, session }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Status only: the upstream body can echo request details and is never forwarded or logged.
      console.error("[realtime/session] upstream status", res.status);
      if (callId) await endCall(auth.id, callId, "failed_connect").catch(() => null);
      return NextResponse.json(
        { error: "realtime_upstream_error", message: realtimeUpstreamMessage(res.status, model) },
        { status: res.status === 429 ? 429 : 502 },
      );
    }
    const data = (await res.json().catch(() => null)) as { value?: unknown; expires_at?: unknown } | null;
    if (!data || typeof data.value !== "string" || !data.value) throw new Error("no client secret in response");
    const expiresAt = typeof data.expires_at === "number" ? data.expires_at : Math.floor(Date.now() / 1000) + SECRET_TTL_SEC;
    return NextResponse.json({ clientSecret: data.value, expiresAt, model, voice, ...(callId ? { callId, maxSeconds } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[realtime/session]", e instanceof Error ? e.message : "unknown error");
    if (callId) await endCall(auth.id, callId, "failed_connect").catch(() => null);
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to start the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

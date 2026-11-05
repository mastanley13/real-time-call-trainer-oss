import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall, type VoiceEngine } from "@/lib/usage";
import { capReached, dailySessionLimit, minutesReserved, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";
import { realtimeKey, realtimeTranscribeModel, realtimeUpstreamMessage, realtimeVoice } from "@/lib/realtime";
import { mintVoiceTier } from "@/lib/voiceTier";
import { orgVoiceTierForUser, voiceModelFor } from "@/lib/voiceTierServer";
import { signMintReceipt } from "@/lib/mintReceipt";

const Body = z.object({ scenario: ScenarioSchema });

/** The secret only has to outlive the SDP exchange; 600s is the documented default. */
const SECRET_TTL_SEC = 600;

/**
 * Mints a short-lived OpenAI Realtime client secret (ek_...) for one practice call.
 * The browser uses it to open a WebRTC session directly with OpenAI; the API key never leaves the server.
 * Docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
 *
 * The model is picked here, on the server, from the organization's voice tier (Standard or Premium, comped gate,
 * src/lib/voiceTier.ts) and is never sent to the browser. `receipt` (src/lib/mintReceipt.ts) is signed proof of
 * that model; the client hands it back when it saves the session so the server can log the model it really minted.
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
  // for the next session. A running call is never switched to another engine, but a Premium call may use only the
  // Premium minutes it reserved, so it ends when those run out (maxSeconds) and the next call starts on standard.
  let callId: string | undefined;
  let engine: VoiceEngine = "premium";
  let maxSeconds = SECRET_TTL_SEC;
  if (meteringEnabled()) {
    // A failed lookup refuses voice (fail closed); text practice never reaches this route.
    const begun = await beginCall(auth.id, scenario).catch((e) => {
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

  // Voice quality, read from the database on every call; the client never chooses it. A comped org on Premium gets
  // the Premium model. A metered call on the paid Premium Voice engine keeps the Premium model it pays for; the
  // engine, its minute caps and engineTier are unchanged by the voice tier.
  const tier = mintVoiceTier(await orgVoiceTierForUser(auth.id), { metered: Boolean(callId), engine });
  const model = voiceModelFor(tier);
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
      if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
      return NextResponse.json(
        { error: "realtime_upstream_error", message: realtimeUpstreamMessage(res.status) },
        { status: res.status === 429 ? 429 : 502 },
      );
    }
    const data = (await res.json().catch(() => null)) as { value?: unknown; expires_at?: unknown } | null;
    if (!data || typeof data.value !== "string" || !data.value) throw new Error("no client secret in response");
    const expiresAt = typeof data.expires_at === "number" ? data.expires_at : Math.floor(Date.now() / 1000) + SECRET_TTL_SEC;
    // No model id in the response: the browser does not need it. The receipt carries it, signed and opaque to the client.
    const receipt = signMintReceipt(auth.id, model);
    return NextResponse.json(
      { clientSecret: data.value, expiresAt, voice, ...(callId ? { callId, maxSeconds } : {}), ...(receipt ? { receipt } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[realtime/session]", e instanceof Error ? e.message : "unknown error");
    if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to start the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

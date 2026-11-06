import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall } from "@/lib/usage";
import { capReached, dailySessionLimit, minutesReserved, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";
import { realtimeTranscribeModel, realtimeUpstreamMessage, realtimeVoice } from "@/lib/realtime";
import { classifyOpenAiResponse, voiceKeyPlan, withOpenAiKeyFailover } from "@/lib/openaiKeys";
import { orgVoiceTierForUser, voiceModelFor } from "@/lib/voiceTierServer";
import { sealMintReceipt } from "@/lib/mintReceipt";

const Body = z.object({ scenario: ScenarioSchema });

/** The secret only has to outlive the SDP exchange; 600s is the documented default. */
const SECRET_TTL_SEC = 600;
/** Hard-coded: every key on this path, slot or explicit, only ever goes to OpenAI. */
const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

/**
 * Mints a short-lived OpenAI Realtime client secret (ek_...) for one practice call.
 * The browser uses it to open a WebRTC session directly with OpenAI; the API key never leaves the server.
 * Docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
 *
 * The model is picked here, on the server, from the organization's voice tier (Standard or Premium, comped gate,
 * src/lib/voiceTier.ts); the client never chooses it, and the response never names it. `receipt`
 * (src/lib/mintReceipt.ts) is that model, encrypted and bound to this user and this call's `sessionId`; the client saves the call under that sessionId with the receipt, so the server
 * can log the model it really minted, once, on that call only.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "realtime");
  if (ipLimited) return ipLimited;

  // OPENAI_REALTIME_API_KEY alone, else the OpenAI key ladder, else LLM_API_KEY on an OpenAI base (openaiKeys.ts).
  const keys = voiceKeyPlan(process.env);
  if (keys.kind === "none") {
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
  // The engine beginCall picks drives minute caps and billing only (TrainerSession.engineTier); it no longer picks the model.
  let callId: string | undefined;
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
    maxSeconds = begun.maxSeconds;
  }

  // Voice quality, read from the database on every call; the client never chooses it. Premium only when the org is
  // comped AND set to premium (effectiveVoiceTier). There is no other way onto the Premium model: the paid Premium
  // Voice engine does not bypass the comped gate. Minute caps, engineTier and metering are unchanged by the tier.
  const model = voiceModelFor(await orgVoiceTierForUser(auth.id));
  // One id per call, fixed before the secret is minted: the metering call id when metered, else a fresh UUID.
  // The receipt is bound to it and the client saves the call under it, so a receipt can't move to another call.
  const sessionId = callId ?? randomUUID();
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

  // Each attempt keeps its own 15 s timeout. A timeout or network error throws and never fails over, so the worst
  // case stays one timeout. `pinned` (the key ladder) also refuses redirects, so a slot key only reaches this URL.
  const mint = (apiKey: string, pinned: boolean) =>
    fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // The secret never outlives the call's reserved minutes. OpenAI only checks it while the session is
      // being set up, so this limits starting a late call, not a running one; billing is settled on the server.
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: Math.max(10, Math.min(SECRET_TTL_SEC, maxSeconds)) }, session }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      ...(pinned ? { redirect: "error" as const } : {}),
    });

  try {
    let res: Response;
    if (keys.kind === "ladder") {
      // Failover happens inside this one request, after beginCall: callId, sessionId, maxSeconds and the receipt
      // binding stay the same. Media and billing follow the project of whichever slot minted the secret.
      const r = await withOpenAiKeyFailover("realtime", async (key) => {
        const attempt = await mint(key, true);
        if (attempt.ok) return { outcome: "ok", value: attempt };
        return { outcome: await classifyOpenAiResponse(CLIENT_SECRETS_URL, attempt), status: attempt.status, value: attempt };
      });
      if (r.kind === "exhausted") {
        if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
        return NextResponse.json(
          { error: "realtime_unavailable", message: "Voice is unavailable right now. Switch to Text to keep practising." },
          { status: 503, headers: { "Retry-After": "300" } },
        );
      }
      res = r.value;
    } else {
      res = await mint(keys.key, false);
    }
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
    // The model id stays server-side: the browser needs only the secret, and the SDP relay never names a model.
    // The receipt is the minted model encrypted (AES-GCM) for this user and this call (sessionId), opaque to the
    // browser. POST /api/transcripts logs the model only from a receipt that opens for the sessionId it is saved
    // under, and only once.
    const receipt = sealMintReceipt(auth.id, sessionId, model);
    return NextResponse.json(
      { clientSecret: data.value, expiresAt, voice, sessionId, ...(callId ? { callId, maxSeconds } : {}), ...(receipt ? { receipt } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[realtime/session]", e instanceof Error ? e.message : "unknown error");
    if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to start the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { meteringEnabled } from "@/lib/serverConfig";
import { beginCall, endCall, type PremiumMintInfo } from "@/lib/usage";
import { emitPremiumEvent } from "@/lib/billingEvents";
import { mintVoiceTier } from "@/lib/voiceTier";
import { capReached, dailySessionLimit, minutesReserved, voiceBlocked, voiceUnavailable } from "@/lib/usageResponses";
import { realtimeKey, realtimeTranscribeModel, realtimeUpstreamMessage, realtimeVoice } from "@/lib/realtime";
import { orgVoiceTierForUser, voiceModelFor } from "@/lib/voiceTierServer";
import { sealMintReceipt } from "@/lib/mintReceipt";
import { recordMintedVoice } from "@/lib/voiceMintLog";

const Body = z.object({ scenario: ScenarioSchema });

/** The secret only has to outlive the SDP exchange; 600s is the documented default. */
const SECRET_TTL_SEC = 600;

/**
 * Mints a short-lived OpenAI Realtime client secret (ek_...) for one practice call.
 * The browser uses it to open a WebRTC session directly with OpenAI; the API key never leaves the server.
 * Docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
 *
 * The model is picked here, on the server, from the organization's voice tier (Standard or Premium, comped gate,
 * src/lib/voiceTier.ts) or the verified paid Premium entitlement (mintVoiceTier); the client never chooses it, and the
 * response never names it (a metered call gets only the tier label). `receipt`
 * (src/lib/mintReceipt.ts) is that model, encrypted and bound to this user and this call's `sessionId`; the client saves the call under that sessionId with the receipt, so the server
 * can log the model it really minted, once, on that call only.
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

  // Voice quality for a comped organization, read from the database on every call; the client never chooses it.
  // Comped overrides billing: it runs Premium without touching the paid Premium minutes.
  const orgTier = await orgVoiceTierForUser(auth.id);

  // Cap check before minting (rule 11). The returned callId keys every later metering write for this call.
  // The engine is chosen here, per session, from the database: paid Premium only while PREMIUM_VOICE_ON_SALE is exactly
  // "true", the add-on is entitled (active or trialing, quantity above 0, period not over) and at least one whole Premium
  // minute is left, else Standard for this session. A running call is never switched to another engine; a paid Premium
  // call's maxSeconds is min(call allowance, Premium left). The engine drives caps and billing (TrainerSession.engineTier);
  // a comped call stays on the standard billing engine and uses no paid Premium minutes.
  let callId: string | undefined;
  let maxSeconds = SECRET_TTL_SEC;
  let premium: PremiumMintInfo | undefined;
  if (meteringEnabled()) {
    // A failed lookup refuses voice (fail closed); text practice never reaches this route.
    const begun = await beginCall(auth.id, scenario, new Date(), { compedPremium: orgTier === "premium" }).catch((e) => {
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
    premium = begun.premium;
  }

  // The model, read from the database on every call; the client never chooses it. Premium only when the org is comped
  // AND set to premium (effectiveVoiceTier), or when the meter started this call on the paid Premium entitlement
  // (premium.source === "paid", which needs the exact sale flag and an entitled add-on). A stored add-on flag alone, or
  // any other engine choice, never reaches the Premium model.
  const tier = mintVoiceTier(orgTier, { paidPremium: premium?.source === "paid" });
  const model = voiceModelFor(tier);
  if (premium?.fallback) {
    await emitPremiumEvent({ name: "premium_fallback_to_standard", subject: "user", subjectId: auth.id, reason: premium.fallback });
  }
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
    // The model id stays server-side: the browser needs only the secret, and the SDP relay never names a model.
    // The receipt is the minted model encrypted (AES-GCM) for this user and this call (sessionId), opaque to the
    // browser. POST /api/transcripts logs the model only from a receipt that opens for the sessionId it is saved
    // under, and only once. A metered call's browser also gets the tier label and whether the next call drops to
    // Standard (the hosted Premium Voice UI); an unmetered call's answer keeps upstream's exact keys.
    // Durable server-side provenance for a metered call: the model actually minted and the effective tier, on the
    // call's own row, now, whether or not the browser ever saves the call. Never returned.
    // The log must land BEFORE the credential is released. If the write throws or updates no row, the secret is dropped
    // unused (nothing returns it, and it expires on its own within the call's reserved time), the call is settled as a
    // server mint failure (nothing billed, its reservation and any Premium minutes released) and the browser gets the
    // same neutral "voice unavailable" answer as a failed usage lookup: no client secret, no receipt.
    if (callId) {
      const logged = await recordMintedVoice(auth.id, callId, { model, tier }).catch((e) => {
        console.error("[realtime/session] mint log failed", e instanceof Error ? e.name : "unknown error");
        return null;
      });
      if (logged !== true) {
        if (logged === false) console.error("[realtime/session] mint log wrote no row");
        await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
        return voiceUnavailable();
      }
    }
    const receipt = sealMintReceipt(auth.id, sessionId, model);
    return NextResponse.json(
      {
        clientSecret: data.value, expiresAt, voice, sessionId,
        ...(callId ? { callId, maxSeconds, voiceTier: tier, nextCallStandard: premium?.nextCallStandard ?? false } : {}),
        ...(receipt ? { receipt } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[realtime/session]", e instanceof Error ? e.message : "unknown error");
    if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to start the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { ipLimitResponse, rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, type Scenario } from "@/lib/scenarios";
import { meteringEnabled, realtimeModelFor } from "@/lib/serverConfig";
import { endCall } from "@/lib/usage";
import { HARD_SESSION_CAP_SECONDS, PROVIDER_LIMIT_GRACE_SECONDS } from "@/lib/usagePlan";
import { voiceUnavailable } from "@/lib/usageResponses";
import { realtimeKey, realtimeUpstreamMessage, realtimeVoice } from "@/lib/realtime";
import { buildRealtimeSession, hangupProviderCall, openProviderCall } from "@/lib/realtimeCalls";
import { hangupCall } from "@/lib/providerHangup";

const Body = z.object({
  // The call id from /api/realtime/session. Required whenever voice is metered; absent only when metering is off.
  callId: z.string().min(1).max(64).optional(),
  sdp: z.string().min(10).max(40_000),
  // Used only when metering is off (no stored call). A metered call is built from the persona stored at mint, and any
  // scenario sent with it is ignored.
  scenario: ScenarioSchema.optional(),
});

/** The old client secret lived 600 s; a minted call may be connected for this long after the mint. */
const MINT_TTL_MS = 600_000;

const invalid = () => NextResponse.json({ error: "invalid_offer", message: "The browser sent an invalid connection offer. Reload the page and try again." }, { status: 400 });
const conflict = (error: string, message: string) => NextResponse.json({ error, message }, { status: 409 });
const upstreamError = (status: number, model: string) => NextResponse.json(
  { error: "realtime_upstream_error", message: status === 0 ? "Could not reach OpenAI to connect the voice call. Check the server's network, then try again." : realtimeUpstreamMessage(status, model) },
  { status: status === 429 ? 429 : 502 },
);

/**
 * Opens the OpenAI Realtime call for a minted session and returns the SDP answer. The server posts the browser's
 * offer and the session config to POST /v1/realtime/calls with its own API key (the unified interface;
 * https://developers.openai.com/api/docs/guides/realtime-webrtc), stores the provider call id from the Location header,
 * and so can hang the call up itself. Media still flows browser <-> OpenAI directly; the browser never holds an OpenAI
 * credential, so it cannot open calls this server does not know about.
 *
 * One provider call per mint, decided before OpenAI is called: the request that wins a conditional update on
 * providerConnectClaimAt owns the mint. Only it may call OpenAI, store the call id, or settle the mint as failed; every
 * other offer gets 409 without a provider call, and a claim is never retaken, so a crashed owner cannot lead to a second
 * provider call. The owner stores the id even if the call ended meanwhile (then hangs it up), so the sweep can always find it.
 * The session is built from the persona stored at mint, not from this request.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const limit = rateLimit({ key: `realtime-sdp:${auth.id}`, limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited", message: "Too many connection attempts. Wait a minute, then start the call again." }, { status: 429 });
  }

  const apiKey = realtimeKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "realtime_not_configured", message: "Voice with OpenAI Realtime needs an OpenAI key. Set OPENAI_API_KEY on the server, or switch to Text." },
      { status: 503 },
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return invalid();
  }

  // With metering on, every provider call belongs to a minted call row: an offer without one is refused, so the cap and
  // the deadline cannot be skipped. With metering off there is no row; the call is hung up by an in-process timer below.
  const metered = meteringEnabled();
  if (metered !== !!body.callId) return invalid();
  // With metering off this route opens provider calls with no mint, so it carries the per-IP limit itself. A metered call
  // already counted against it at /api/realtime/session, so it is not counted twice.
  if (!metered) {
    const ipLimited = ipLimitResponse(req, "realtime");
    if (ipLimited) return ipLimited;
  }

  let model = realtimeModelFor("premium");
  let scenario: Scenario | undefined = body.scenario;
  const callId = body.callId;
  if (callId) {
    const call = await prisma.trainerSession.findUnique({
      where: { id: callId },
      select: { userId: true, createdAt: true, endedAt: true, providerCallId: true, providerConnectClaimAt: true, providerSession: true, engineTier: true },
    }).catch((e) => {
      console.error("[realtime/sdp] call lookup failed", e instanceof Error ? e.name : "unknown");
      return undefined;
    });
    if (call === undefined) return voiceUnavailable();
    if (!call || call.userId !== auth.id) return NextResponse.json({ error: "not_found", message: "That call was not found." }, { status: 404 });
    if (call.endedAt) return conflict("call_ended", "That call has already ended. Start the call again.");
    if (call.providerCallId || call.providerConnectClaimAt) return conflict("call_already_connected", "That call is already connected. Start a new call instead.");
    if (Date.now() - call.createdAt.getTime() > MINT_TTL_MS) return conflict("realtime_session_expired", "The voice session expired before it connected. Start the call again.");
    const stored = ScenarioSchema.safeParse(call.providerSession);
    if (!stored.success) return conflict("call_not_ready", "That call cannot be connected. Start the call again.");
    scenario = stored.data;
    model = realtimeModelFor(call.engineTier === "premium" ? "premium" : "standard");

    // The claim: exactly one request gets past this. Losers never reach OpenAI.
    const claimed = await prisma.trainerSession.updateMany({
      where: { id: callId, userId: auth.id, endedAt: null, providerCallId: null, providerConnectClaimAt: null },
      data: { providerConnectClaimAt: new Date() },
    }).catch((e) => {
      console.error("[realtime/sdp] claim failed", e instanceof Error ? e.name : "unknown");
      return undefined;
    });
    if (claimed === undefined) return voiceUnavailable();
    if (claimed.count === 0) return conflict("call_already_connected", "That call is already connected, or has ended. Start a new call instead.");
  }
  if (!scenario) return invalid();

  const opened = await openProviderCall(apiKey, body.sdp, buildRealtimeSession(scenario, model, realtimeVoice(scenario.aiPersona.realtimeVoice)));
  if (!opened.ok) {
    // This request owns the mint, so the failure is its own: settle as a failed connect, never charged.
    if (callId) await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
    return upstreamError(opened.status, model);
  }

  if (callId) {
    // Store the id before anything else (the claim is ours, so this cannot lose a race), whether or not the call has ended.
    let stored = false;
    for (let attempt = 0; attempt < 2 && !stored; attempt++) {
      try {
        stored = (await prisma.trainerSession.updateMany({ where: { id: callId, providerCallId: null }, data: { providerCallId: opened.providerCallId } })).count === 1;
      } catch (e) {
        console.error("[realtime/sdp] storing the call id failed", e instanceof Error ? e.name : "unknown");
      }
    }
    if (!stored) {
      // The id cannot be recorded, so the sweep could never find this call: end it now and settle the mint.
      await hangupProviderCall(apiKey, opened.providerCallId);
      await endCall(auth.id, callId, "failed_connect", new Date(), { serverMintFailure: true }).catch(() => null);
      return voiceUnavailable();
    }
    const row = await prisma.trainerSession.findUnique({ where: { id: callId }, select: { endedAt: true } }).catch(() => null);
    if (row?.endedAt) {
      // Settled while OpenAI was answering (reaped as silent, or ended by the user): the provider call must not run on.
      await hangupCall(callId);
      return conflict("call_ended", "That call has already ended. Start the call again.");
    }
  } else {
    // Metering off: no row to sweep. Best effort only, in this process: a restart or a serverless instance that is
    // frozen loses the timer, so a self-hosted install without metering has no durable ceiling.
    const timer = setTimeout(() => { void hangupProviderCall(apiKey, opened.providerCallId); }, (HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS) * 1000);
    timer.unref?.();
  }

  return NextResponse.json({ sdp: opened.sdp }, { headers: { "Cache-Control": "no-store" } });
}

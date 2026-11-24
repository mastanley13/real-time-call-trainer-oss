import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { buildLiveInstructions, isLiveVoice, liveSessionBody, liveUpstreamMessage } from "@/lib/live";
import { openLiveTicket } from "@/lib/liveTicket";
import { classifyOpenAiResponse, voiceKeyPlan, withOpenAiKeyFailover } from "@/lib/openaiKeys";

const Body = z.object({
  liveTicket: z.string().min(10).max(600),
  sessionId: z.string().min(8).max(64),
  sdp: z.string().min(10).max(40_000),
  scenario: ScenarioSchema,
});

/** Hard-coded: every key on this path only ever goes to OpenAI. */
const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";

/**
 * Starts a GPT-Live voice session (OPENAI_VOICE_API=live) for a call /api/realtime/session already approved.
 *
 * Documented WebRTC exchange (https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): the server posts
 * JSON { session, transport: { type: "webrtc", sdp } } to /v1/live/sessions with the project API key and returns the
 * SDP answer. The key never leaves the server and the page's CSP keeps connect-src to 'self'; media flows browser <->
 * OpenAI directly.
 *
 * The model and voice come only from the sealed ticket, never from the browser. The persona prompt is built here from
 * the scenario, the same one the session route checked (a trainee can already pick or edit any scenario they run).
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const limit = rateLimit({ key: `live-sdp:${auth.id}`, limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited", message: "Too many connection attempts. Wait a minute, then start the call again." }, { status: 429 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_offer", message: "The browser sent an invalid connection offer. Reload the page and try again." }, { status: 400 });
  }

  const ticket = openLiveTicket(body.liveTicket, auth.id, body.sessionId);
  if (!ticket || !isLiveVoice(ticket.voice)) {
    return NextResponse.json({ error: "realtime_secret_expired", message: "The voice session expired before it connected. Start the call again." }, { status: 401 });
  }

  const keys = voiceKeyPlan(process.env);
  if (keys.kind === "none") {
    return NextResponse.json({ error: "realtime_not_configured", message: "Voice needs an OpenAI key. Set OPENAI_API_KEY on the server, or switch to Text." }, { status: 503 });
  }

  const payload = JSON.stringify(liveSessionBody({
    model: ticket.model,
    voice: ticket.voice,
    instructions: buildLiveInstructions(body.scenario),
    openingLine: body.scenario.aiPersona.openingLine,
    sdp: body.sdp,
  }));
  const start = (apiKey: string, pinned: boolean) =>
    fetch(LIVE_SESSIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: payload,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      ...(pinned ? { redirect: "error" as const } : {}),
    });

  try {
    let res: Response;
    if (keys.kind === "ladder") {
      const r = await withOpenAiKeyFailover("realtime", async (key) => {
        const attempt = await start(key, true);
        if (attempt.ok) return { outcome: "ok", value: attempt };
        return { outcome: await classifyOpenAiResponse(LIVE_SESSIONS_URL, attempt), status: attempt.status, value: attempt };
      });
      if (r.kind === "exhausted") {
        return NextResponse.json({ error: "realtime_unavailable", message: "Voice is unavailable right now. Switch to Text to keep practicing." }, { status: 503, headers: { "Retry-After": "300" } });
      }
      res = r.value;
    } else {
      res = await start(keys.key, false);
    }
    if (!res.ok) {
      // Status only: the upstream body can echo request details and is never forwarded or logged.
      console.error("[live/sdp] upstream status", res.status);
      return NextResponse.json({ error: "realtime_upstream_error", message: liveUpstreamMessage(res.status) }, { status: res.status === 429 ? 429 : 502 });
    }
    const data = (await res.json().catch(() => null)) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
    const sdp = data?.transport?.sdp;
    if (typeof sdp !== "string" || !sdp.trim()) throw new Error("no SDP answer in response");
    // The Live session id is opaque and kept for support; it never names a model.
    const liveSessionId = typeof data?.session?.id === "string" ? data.session.id : undefined;
    return NextResponse.json({ sdp, ...(liveSessionId ? { liveSessionId } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[live/sdp]", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "realtime_upstream_error", message: "Could not reach OpenAI to connect the voice call. Check the server's network, then try again." }, { status: 502 });
  }
}

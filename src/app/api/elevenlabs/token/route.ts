import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";

/**
 * Mints a short-lived WebRTC conversation token for the configured
 * ElevenLabs agent. The API key never leaves the server.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

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

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      console.error("[elevenlabs/token] upstream status", res.status);
      return NextResponse.json(
        { error: "elevenlabs_upstream_error", message: `ElevenLabs returned ${res.status}. Check your API key and agent id.` },
        { status: 502 },
      );
    }
    const { token } = await res.json();
    if (!token) throw new Error("no token in response");
    return NextResponse.json({ token });
  } catch (e) {
    console.error("[elevenlabs/token]", e);
    return NextResponse.json({ error: "elevenlabs_upstream_error", message: "Could not reach ElevenLabs." }, { status: 502 });
  }
}

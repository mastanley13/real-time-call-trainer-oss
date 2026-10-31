import { NextResponse } from "next/server";

/** The 409 when the plan has minutes left but open calls have reserved them all. */
export function minutesReserved(): NextResponse {
  return NextResponse.json(
    { error: "minutes_reserved", message: "Another call is using your remaining voice minutes. End it, then start this call again." },
    { status: 409 },
  );
}

/** The 429 for a user whose last call ran past its reservation. */
export function voiceBlocked(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "voice_blocked", message: "Your last voice call ran past its time limit. Wait a few minutes, then start a new call, or switch to Text." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
  );
}

/** The 503 when the call needs the standard voice engine and the server has none configured. */
export function standardVoiceUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "standard_voice_not_configured", message: "Standard voice is not set up on the server. Switch to Text to practise now, or ask an admin to add the Premium Voice plan." },
    { status: 503 },
  );
}

/** The 402 every voice-start route returns when the allowance is empty. One wording, one status. */
export function capReached(): NextResponse {
  return NextResponse.json(
    { error: "cap_reached", message: "You have used all your voice minutes for this period. Switch to Text to keep practising, or upgrade your plan." },
    { status: 402 },
  );
}

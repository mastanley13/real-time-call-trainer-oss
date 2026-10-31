import { NextResponse } from "next/server";

/** The 402 every voice-start route returns when the allowance is empty. One wording, one status. */
export function capReached(): NextResponse {
  return NextResponse.json(
    { error: "cap_reached", message: "You have used all your voice minutes for this period. Switch to Text to keep practising, or upgrade your plan." },
    { status: 402 },
  );
}

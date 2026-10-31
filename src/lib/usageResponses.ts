import { NextResponse } from "next/server";

/** The 409 when the plan has minutes left but open calls have reserved them all. */
export function minutesReserved(): NextResponse {
  return NextResponse.json(
    { error: "minutes_reserved", message: "Another call is using your remaining voice minutes. End it, then start this call again." },
    { status: 409 },
  );
}

/** The 402 every voice-start route returns when the allowance is empty. One wording, one status. */
export function capReached(): NextResponse {
  return NextResponse.json(
    { error: "cap_reached", message: "You have used all your voice minutes for this period. Switch to Text to keep practising, or upgrade your plan." },
    { status: 402 },
  );
}

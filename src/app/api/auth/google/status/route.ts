import { NextResponse } from "next/server";
import { googleEnabled } from "@/lib/googleAuth";

/**
 * Whether Google sign-in is configured, for the button on /login and /register. It lives under /api/auth/ so it
 * stays reachable behind TRAINER_ACCESS_CODE like password login does (/api/config is gated). One boolean, no secrets.
 */
export async function GET() {
  return NextResponse.json({ enabled: googleEnabled() }, { headers: { "Cache-Control": "no-store" } });
}

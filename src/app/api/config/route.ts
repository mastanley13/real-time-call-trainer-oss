import { NextResponse } from "next/server";
import { getCapabilities } from "@/lib/serverConfig";

/** Public capability flags so the UI can show "not configured" states. */
export async function GET() {
  return NextResponse.json(getCapabilities());
}

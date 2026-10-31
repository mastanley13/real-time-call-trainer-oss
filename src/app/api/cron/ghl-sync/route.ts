import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/serverConfig";
import { ghlEnabled } from "@/lib/ghl/client";
import { drainGhlOutbox } from "@/lib/ghl/outbox";
import { scanWentQuiet } from "@/lib/ghl/events";

/**
 * Daily GoHighLevel sync: queues went_quiet for free users who stopped calling or whose
 * trial ended unpaid, then drains the outbox (the durable fallback for events whose
 * after-response send failed). A no-op unless GHL_SYNC_ENABLED=true, and never in DEMO_MODE.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} only, like /api/cron/purge-expired.
 * Never returns provider bodies or user details, only counts.
 */

const authorize = (req: NextRequest) => cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET);

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ghlEnabled()) {
    return NextResponse.json({ ok: true, enabled: false });
  }
  try {
    const wentQuiet = await scanWentQuiet();
    const drained = await drainGhlOutbox({ limit: 100 });
    return NextResponse.json({ ok: true, enabled: true, wentQuiet, ...drained });
  } catch {
    console.error("[cron/ghl-sync] failed");
    return NextResponse.json({ ok: false, error: "ghl_sync_failed" }, { status: 500 });
  }
}

// Allow POST too so it's easy to test from curl.
export const POST = GET;

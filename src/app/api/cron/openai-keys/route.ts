import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { openAiKeyHealth } from "@/lib/openaiKeys";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { cronAuthorized, getCapabilities } from "@/lib/serverConfig";

/**
 * GET /api/cron/openai-keys: OpenAI key slot health for this server instance (slot numbers and states only).
 *
 * Mounted under /api/cron/ because the access-gate exemption in src/middleware.ts matches /api/health exactly, not
 * by prefix, while /api/cron/ is a prefix exemption. /api/health itself is unauthenticated and gains nothing here.
 *
 * Callers: cron with "Authorization: Bearer ${CRON_SECRET}" (constant-time, cronAuthorized), or a signed-in
 * platform admin. x-vercel-cron is never trusted. Org owners and managers get 403. Demo mode answers 404.
 *
 * GET reads in-memory state only: no OpenAI call, no cooldown reset, no write. "unknown" means configured but not
 * used yet on this instance, not healthy. The response never carries a key, part or hash of a key, a base URL or a
 * model id.
 */

const LIMIT = 30;
const WINDOW_MS = 60_000;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

function limited(key: string) {
  const r = rateLimit({ key: `keyhealth:${key}`, limit: LIMIT, windowMs: WINDOW_MS });
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  return json({ error: "rate_limited", message: `Too many key health checks. Wait ${retryAfter} seconds and try again.`, retryAfter }, 429, { "Retry-After": String(retryAfter) });
}

export async function GET(req: NextRequest) {
  const caps = getCapabilities();
  // No admin concept in demo mode, and requireAuth would return the demo user.
  if (caps.demoMode) return json({ error: "not_found" }, 404);

  if (cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    const over = limited(`cron:${clientIp(req)}`);
    if (over) return over;
    return json(openAiKeyHealth(), 200);
  }

  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const over = limited(`user:${auth.id}`);
  if (over) return over;

  if (!caps.database) return json({ error: "forbidden", message: "Only platform admins can read OpenAI key health." }, 403);
  let isAdmin = false;
  try {
    const actor = await prisma.user.findUnique({ where: { id: auth.id }, select: { isPlatformAdmin: true } });
    isAdmin = Boolean(actor?.isPlatformAdmin);
  } catch (e) {
    console.error("[cron/openai-keys] admin lookup failed", e instanceof Error ? e.name : "unknown");
    return json({ error: "lookup_failed", message: "Could not check your account. Try again in a minute." }, 503);
  }
  if (!isAdmin) return json({ error: "forbidden", message: "Only platform admins can read OpenAI key health." }, 403);
  return json(openAiKeyHealth(), 200);
}

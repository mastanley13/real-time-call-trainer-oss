import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { meteringEnabled } from "@/lib/serverConfig";
import { creditManual } from "@/lib/usage";

const Body = z.object({
  userId: z.string().min(1).max(64),
  minutes: z.number().int().min(1).max(1000),
  reason: z.string().trim().min(1).max(200),
});

/** Support credit: platform admins only. Writes a credit_manual ledger entry and an audit event. */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!meteringEnabled()) return NextResponse.json({ error: "metering_off" }, { status: 404 });

  const actor = await prisma.user.findUnique({ where: { id: auth.id }, select: { isPlatformAdmin: true } });
  if (!actor?.isPlatformAdmin) return NextResponse.json({ error: "forbidden", message: "Only platform admins can credit minutes." }, { status: 403 });

  const ipLimited = ipLimitResponse(req, "usage");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "usage");
  if (userLimited) return userLimited;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "A credit needs a user id, whole minutes from 1 to 1000, and a reason." }, { status: 400 });
  }

  const result = await creditManual({ targetUserId: body.userId, minutes: body.minutes, actorId: auth.id, reason: body.reason });
  if (!result) return NextResponse.json({ error: "not_found", message: "That user was not found." }, { status: 404 });
  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";

/** Fetch one session. Owners can read their own; managers/owners can read their org's. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const session = await prisma.trainerSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (session.userId !== auth.id) {
    const actor = await prisma.user.findUnique({ where: { id: auth.id } });
    const allowed =
      !!actor &&
      (actor.isPlatformAdmin ||
        ((actor.role === "manager" || actor.role === "owner") && actor.organizationId === session.organizationId));
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ session });
}

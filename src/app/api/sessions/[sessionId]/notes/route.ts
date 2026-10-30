import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { canCoachMember } from "@/lib/teamScope";

/** The rep's manager link, for the manager-scope check. */
async function repOf(userId: string) {
  const rep = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, managerId: true } });
  return { managerId: rep?.managerId ?? null };
}

/**
 * Supervisor notes on a training session.
 *
 * Visible to the trainee (who owns the session), the rep's own manager and
 * owners of the same org. Writable by that manager, org owners or a platform
 * admin (canCoachMember in teamScope.ts).
 */

const BodySchema = z.object({
  note: z.string().max(4000),
  /**
   * supervisorNotesAt as the editor loaded it (null for an empty note). When
   * sent, the save only lands if nobody changed the note since; clients that
   * omit it overwrite as before.
   */
  expectedNotesAt: z.string().datetime().nullable().optional(),
});

const NOTE_SELECT = {
  id: true,
  supervisorNotes: true,
  supervisorNotesBy: true,
  supervisorNotesAt: true,
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const auth = requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const user = auth;

  const { sessionId } = await params;

  const session = await prisma.trainerSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      supervisorNotes: true,
      supervisorNotesBy: true,
      supervisorNotesAt: true,
    },
  });
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const actor = await prisma.user.findUnique({ where: { id: user.id } });
  const canRead =
    user.id === session.userId ||
    (!!actor &&
      canCoachMember(actor, { id: session.userId, organizationId: session.organizationId, ...(await repOf(session.userId)) }));
  if (!canRead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    sessionId: session.id,
    supervisorNotes: session.supervisorNotes,
    supervisorNotesBy: session.supervisorNotesBy,
    supervisorNotesAt: session.supervisorNotesAt,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const auth = requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const user = auth;

  const limit = rateLimit({
    key: `notes:${user.id}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { sessionId } = await params;

  const actor = await prisma.user.findUnique({ where: { id: user.id } });
  if (!actor) {
    return NextResponse.json({ error: "Unknown user" }, { status: 401 });
  }

  const session = await prisma.trainerSession.findUnique({
    where: { id: sessionId },
    select: { id: true, organizationId: true, userId: true },
  });
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const canWrite = canCoachMember(actor, { id: session.userId, organizationId: session.organizationId, ...(await repOf(session.userId)) });

  if (!canWrite) {
    return NextResponse.json(
      { error: "Only the rep's manager or an owner of this organization can post supervisor notes." },
      { status: 403 },
    );
  }

  let body;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const authorLabel =
    [actor.firstName, actor.lastName].filter(Boolean).join(" ") ||
    actor.email;

  const trimmed = body.note.trim();
  const data = {
    supervisorNotes: trimmed.length ? trimmed : null,
    supervisorNotesBy: trimmed.length ? authorLabel : null,
    supervisorNotesAt: trimmed.length ? new Date() : null,
  };

  let updated;
  if (body.expectedNotesAt === undefined) {
    updated = await prisma.trainerSession.update({
      where: { id: sessionId },
      data,
      select: NOTE_SELECT,
    });
  } else {
    // The timestamp check and the write are one UPDATE, so two managers saving
    // at once can't both win. The column is TIMESTAMP(3) and only ever set from
    // new Date() above, so the millisecond ISO string GET returned matches it
    // exactly. The re-select runs in the same transaction, behind the row lock
    // the update took, so it returns this save and not a later one.
    const expected =
      body.expectedNotesAt === null ? null : new Date(body.expectedNotesAt);
    const [{ count }, row] = await prisma.$transaction([
      prisma.trainerSession.updateMany({
        where: { id: sessionId, supervisorNotesAt: expected },
        data,
      }),
      prisma.trainerSession.findUnique({
        where: { id: sessionId },
        select: NOTE_SELECT,
      }),
    ]);
    if (count === 0 || !row) {
      return NextResponse.json(
        {
          error: "conflict",
          message:
            "Someone changed this note after you opened it. Open it again to see the latest version.",
        },
        { status: 409 },
      );
    }
    updated = row;
  }

  await prisma.auditEvent.create({
    data: {
      userId: actor.id,
      action: "session.supervisor_notes_updated",
      resource: session.id,
      metadata: {
        length: trimmed.length,
        trainee: session.userId,
      } satisfies Prisma.InputJsonValue,
    },
  });

  return NextResponse.json(updated);
}

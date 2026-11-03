import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { LIBRARY } from "@/lib/personas";
import { readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { canManageTeam } from "@/lib/team";
import { ImportSchema, knownLibraryIds } from "@/lib/teamPersonas";
import { loadActor, noOrganization, serverError, teamIsLocal } from "../../team/_lib/server";

/**
 * Onboarding import: saves the org's industries and adds library personas to
 * the team list. Idempotent: personas already on the list are skipped.
 * Managers, owners and platform admins only.
 */
const byId = new Map(LIBRARY.map((s) => [s.id, s]));

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) {
    return NextResponse.json({ error: "local_only", message: "Demo mode has no team list. Connect a database to import personas for a team." }, { status: 400 });
  }
  const limited = userLimitResponse(auth.id, "personas");
  if (limited) return limited;

  let body: z.infer<typeof ImportSchema>;
  try {
    const parsed = ImportSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request", message: "Pick industries from the list and at most 300 personas." }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON or was too large." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) {
      return NextResponse.json({ error: "forbidden", message: "Only managers and owners can import personas for the team." }, { status: 403 });
    }
    if (!actor.organizationId) return noOrganization();
    const orgId = actor.organizationId;
    const ids = knownLibraryIds(body.libraryIds, LIBRARY);

    const result = await prisma.$transaction(async (tx) => {
      if (body.industries) await tx.organization.update({ where: { id: orgId }, data: { industries: body.industries } });
      const added = await tx.teamPersona.createMany({
        data: ids.map((id) => {
          const s = byId.get(id)!;
          return { organizationId: orgId, createdById: actor.id, scenarioId: id, source: "library", title: s.title, role: s.role };
        }),
        skipDuplicates: true,
      });
      return added.count;
    });
    await prisma.auditEvent.create({
      data: { userId: actor.id, action: "team.personas_imported", metadata: { added: result, requested: ids.length, industries: body.industries ?? null } },
    });
    return NextResponse.json({ added: result, skipped: ids.length - result, ignored: body.libraryIds.length - ids.length });
  } catch (error) {
    console.error("[/api/personas/import] error:", error);
    return serverError("import the personas");
  }
}

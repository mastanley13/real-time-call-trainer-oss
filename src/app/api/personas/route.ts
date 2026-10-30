import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { canManageTeam } from "@/lib/team";
import { asTeamPersona, CreateSchema, isTeamPersonaId, MAX_CUSTOM_PERSONAS, type TeamPersonaView } from "@/lib/teamPersonas";
import { loadActor, noOrganization, serverError, teamIsLocal } from "../team/_lib/server";

/**
 * The team's persona list, scoped to the actor's org.
 *
 * GET     any member: imported library ids, custom team personas, the org's industries
 * POST    manager/owner: save a custom persona for the whole team
 * DELETE  ?id=  manager/owner: remove a persona from the team list
 */

const IdParam = z.string().trim().min(1).max(80);
const localOnly = () =>
  NextResponse.json({ error: "local_only", message: "Demo mode keeps personas in this browser. Connect a database to share them with your team." }, { status: 400 });
const managersOnly = () =>
  NextResponse.json({ error: "forbidden", message: "Only managers and owners can change the team's personas." }, { status: 403 });

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return NextResponse.json({ personas: [], industries: [], local: true });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!actor.organizationId) return NextResponse.json({ personas: [], industries: [] });
    const [org, rows] = await Promise.all([
      prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { industries: true } }),
      prisma.teamPersona.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: "asc" }, take: 500 }),
    ]);
    const personas: TeamPersonaView[] = rows.flatMap((r): TeamPersonaView[] => {
      if (r.source !== "custom") return [{ scenarioId: r.scenarioId, source: "library" as const, title: r.title, role: r.role }];
      // Stored rows were validated on write; re-parse so a schema change never ships a broken persona.
      const parsed = ScenarioSchema.safeParse(r.data);
      return parsed.success ? [{ scenarioId: r.scenarioId, source: "custom" as const, title: r.title, role: r.role, scenario: { ...parsed.data, builtIn: false } }] : [];
    });
    return NextResponse.json({ personas, industries: org?.industries ?? [], canEdit: canManageTeam(actor.role, actor.isPlatformAdmin) });
  } catch (error) {
    console.error("[/api/personas] GET error:", error);
    return serverError("load your team's personas");
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = userLimitResponse(auth.id, "personas");
  if (limited) return limited;

  let body: z.infer<typeof CreateSchema>;
  try {
    const parsed = CreateSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_persona", message: "That persona is missing required fields. Check it in the editor and try again." }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON or was too large." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return managersOnly();
    if (!actor.organizationId) return noOrganization();
    const count = await prisma.teamPersona.count({ where: { organizationId: actor.organizationId, source: "custom" } });
    if (count >= MAX_CUSTOM_PERSONAS) {
      return NextResponse.json({ error: "too_many_personas", message: `Your team has ${MAX_CUSTOM_PERSONAS} custom personas. Remove one before adding another.` }, { status: 400 });
    }
    const scenario = asTeamPersona(body.scenario, randomUUID().slice(0, 12));
    const row = await prisma.teamPersona.create({
      data: {
        organizationId: actor.organizationId,
        createdById: actor.id,
        scenarioId: scenario.id,
        source: "custom",
        title: scenario.title,
        role: scenario.role,
        data: scenario as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.auditEvent.create({ data: { userId: actor.id, action: "team.persona_created", resource: row.scenarioId } });
    const view: TeamPersonaView = { scenarioId: row.scenarioId, source: "custom", title: row.title, role: row.role, scenario };
    return NextResponse.json({ persona: view }, { status: 201 });
  } catch (error) {
    console.error("[/api/personas] POST error:", error);
    return serverError("save the persona");
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = userLimitResponse(auth.id, "personas");
  if (limited) return limited;

  const id = IdParam.safeParse(req.nextUrl.searchParams.get("id") ?? "");
  if (!id.success) return NextResponse.json({ error: "invalid_query", message: "Say which persona to remove with ?id=." }, { status: 400 });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return managersOnly();
    if (!actor.organizationId) return noOrganization();
    const removed = await prisma.teamPersona.deleteMany({ where: { organizationId: actor.organizationId, scenarioId: id.data } });
    if (!removed.count) return NextResponse.json({ error: "Not found", message: "That persona is not on your team's list." }, { status: 404 });
    await prisma.auditEvent.create({
      data: { userId: actor.id, action: "team.persona_removed", resource: id.data, metadata: { custom: isTeamPersonaId(id.data) } },
    });
    return NextResponse.json({ ok: true, id: id.data });
  } catch (error) {
    console.error("[/api/personas] DELETE error:", error);
    return serverError("remove the persona");
  }
}

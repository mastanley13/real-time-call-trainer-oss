import "server-only";
import { NextResponse } from "next/server";
import type { CustomScenario, Prisma, User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { LIBRARY } from "@/lib/personas";
import { readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema, type Scenario } from "@/lib/scenarios";
import { getCapabilities } from "@/lib/serverConfig";

export interface CustomScenarioRecord {
  id: string;
  userId: string;
  organizationId: string | null;
  sharedWithOrg: boolean;
  keepRealNames: boolean;
  sourceUrl: string | null;
  updatedAt: string;
  createdAt: string;
  canEdit: boolean;
  scenario: Scenario;
}

export const MAX_CUSTOM_SCENARIOS_PER_USER = 100;
export const ScenarioId = z.string().regex(/^[a-zA-Z0-9_-]{3,80}$/);

// The source is metadata only: this path never fetches it. Reject credentials and
// non-web URLs, and store the canonical URL without a fragment.
const SourceUrl = z.string().trim().max(500).url().transform((value, ctx) => {
  const url = new URL(value);
  url.hash = "";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 500) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid public web address." });
    return z.NEVER;
  }
  return url.href;
});

export const ScenarioSaveBody = z.object({
  scenario: ScenarioSchema.extend({ id: ScenarioId }),
  sharedWithOrg: z.boolean().optional(),
  keepRealNames: z.boolean().optional(),
  sourceUrl: SourceUrl.nullable().optional(),
});
export const ScenarioUpdateBody = ScenarioSaveBody.extend({
  expectedUpdatedAt: z.string().max(30).datetime().optional(),
});
type SaveBody = z.infer<typeof ScenarioSaveBody>;
type Actor = Pick<User, "id" | "role" | "organizationId" | "isPlatformAdmin">;
type Scope = Pick<CustomScenario, "userId" | "organizationId" | "sharedWithOrg">;

export function scenarioDatabaseAvailable() {
  const capabilities = getCapabilities();
  return capabilities.database && !capabilities.demoMode;
}

export function scenarioDatabaseUnavailable() {
  return NextResponse.json({ error: "database_not_configured", message: "Account sync requires a database. Saved locally in this browser instead." }, { status: 503 });
}

export const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });
export const unknownUser = () => NextResponse.json({ error: "unknown_user" }, { status: 401 });
const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });
export const invalidScenario = () => NextResponse.json({ error: "invalid_request", message: "Send a valid persona with a matching id." }, { status: 400 });
const idConflict = () => NextResponse.json({ error: "id_conflict", message: "This persona id is already in use. Save it with a new id." }, { status: 409 });
const conflict = (row: CustomScenario) => NextResponse.json({
  error: "conflict", message: "This persona was updated elsewhere. Reload and try again.", updatedAt: row.updatedAt.toISOString(),
}, { status: 409 });

export async function parseScenarioBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T> | NextResponse> {
  try {
    return schema.parse(await readJsonLimited(req));
  } catch (error) {
    if (error instanceof Error && error.message === "too_large") {
      return NextResponse.json({ error: "payload_too_large", message: "Send only the persona to save." }, { status: 413 });
    }
    return invalidScenario();
  }
}

export function scenarioActor(userId: string, db: Pick<Prisma.TransactionClient, "user"> = prisma): Promise<Actor | null> {
  return db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, organizationId: true, isPlatformAdmin: true } });
}

const manages = (actor: Actor) => actor.role === "manager" || actor.role === "owner";
const sameOrg = (actor: Actor, row: Scope) => row.organizationId !== null && actor.organizationId === row.organizationId;

export function canReadScenario(actor: Actor, row: Scope): boolean {
  return actor.id === row.userId || actor.isPlatformAdmin || (sameOrg(actor, row) && (row.sharedWithOrg || manages(actor)));
}

export function canEditScenario(actor: Actor, row: Scope): boolean {
  return actor.id === row.userId || actor.isPlatformAdmin || (sameOrg(actor, row) && row.sharedWithOrg && manages(actor));
}

export function scenarioRecord(actor: Actor, row: CustomScenario): CustomScenarioRecord {
  return {
    id: row.id, userId: row.userId, organizationId: row.organizationId,
    sharedWithOrg: row.sharedWithOrg, keepRealNames: row.keepRealNames, sourceUrl: row.sourceUrl,
    updatedAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString(),
    canEdit: canEditScenario(actor, row), scenario: ScenarioSchema.parse(row.data),
  };
}

// Serialize writes to a persona (including competing creates), and serialize
// creates per account so simultaneous POSTs cannot exceed the storage cap.
async function lock(tx: Prisma.TransactionClient, scope: string, id: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`ct-custom-scenario:${scope}:${id}`}::text))`;
}

function saveData(actor: Actor, body: SaveBody, previous?: CustomScenario) {
  const owns = !previous || previous.userId === actor.id;
  const organizationId = owns ? actor.organizationId : previous.organizationId;
  const mayShare = !!actor.organizationId && !!organizationId && (manages(actor) || actor.isPlatformAdmin);
  if (body.sharedWithOrg === true && !mayShare) return forbidden();

  // An owner changing organizations cannot silently carry a share into the new org.
  const keepShare = previous?.sharedWithOrg === true && previous.organizationId === organizationId && (!owns || mayShare);
  const sharedWithOrg = !!organizationId && (body.sharedWithOrg ?? keepShare);
  const scenario: Scenario = { ...body.scenario, builtIn: false, status: "draft" };
  return {
    organizationId, sharedWithOrg,
    keepRealNames: body.keepRealNames ?? previous?.keepRealNames ?? true,
    sourceUrl: body.sourceUrl === undefined ? previous?.sourceUrl ?? null : body.sourceUrl,
    title: scenario.title, role: scenario.role, industry: scenario.industry,
    difficulty: scenario.difficulty, callType: scenario.callType,
    data: scenario as Prisma.InputJsonValue,
    // Even two writes in the same millisecond must have different versions.
    updatedAt: new Date(Math.max(Date.now(), (previous?.updatedAt.getTime() ?? 0) + 1)),
  };
}

export async function saveCustomScenario(userId: string, body: SaveBody) {
  const id = body.scenario.id;
  if (LIBRARY.some((scenario) => scenario.id === id)) return idConflict();

  return prisma.$transaction(async (tx) => {
    await lock(tx, "user", userId);
    await lock(tx, "id", id);
    const actor = await scenarioActor(userId, tx);
    if (!actor) return unknownUser();
    const previous = await tx.customScenario.findUnique({ where: { id } });
    if (previous && previous.userId !== actor.id) return idConflict();
    const data = saveData(actor, body, previous ?? undefined);
    if (data instanceof NextResponse) return data;
    if (!previous && await tx.customScenario.count({ where: { userId } }) >= MAX_CUSTOM_SCENARIOS_PER_USER) {
      return NextResponse.json({ error: "scenario_limit", message: "You can save up to 100 custom personas. Delete one before saving another." }, { status: 409 });
    }
    const row = previous
      ? await tx.customScenario.update({ where: { id }, data })
      : await tx.customScenario.create({ data: { ...data, id, userId } });
    return NextResponse.json({ item: scenarioRecord(actor, row) }, { status: 201 });
  });
}

export async function changeCustomScenario(userId: string, id: string, body?: z.infer<typeof ScenarioUpdateBody>) {
  if (!ScenarioId.safeParse(id).success) return notFound();
  if (body && body.scenario.id !== id) return invalidScenario();

  return prisma.$transaction(async (tx) => {
    await lock(tx, "id", id);
    const actor = await scenarioActor(userId, tx);
    if (!actor) return unknownUser();
    const row = await tx.customScenario.findUnique({ where: { id } });
    if (!row || !canReadScenario(actor, row)) return notFound();
    if (!canEditScenario(actor, row)) return forbidden();
    if (!body) {
      await tx.customScenario.delete({ where: { id } });
      return NextResponse.json({ ok: true });
    }
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== row.updatedAt.toISOString()) return conflict(row);
    const data = saveData(actor, body, row);
    if (data instanceof NextResponse) return data;
    const updated = await tx.customScenario.update({ where: { id }, data });
    return NextResponse.json({ item: scenarioRecord(actor, updated) });
  });
}

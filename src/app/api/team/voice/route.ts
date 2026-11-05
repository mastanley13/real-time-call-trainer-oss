import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { storedOrDefaultTier, tierToStore } from "@/lib/tenant";
import { VOICE_TIERS, canEditVoiceTier, canSetVoiceTier, effectiveVoiceTier, normalizeVoiceTier } from "@/lib/voiceTier";
import { limitFor, loadActor, noOrganization, serverError, teamIsLocal, type Actor } from "../_lib/server";

/**
 * Voice quality for the organization's OpenAI Realtime calls: Standard (default) or Premium.
 * /api/realtime/session reads the stored tier on every call, so a change applies to the next call.
 *
 * GET    any member: { tier, comped, canEdit }, plus { selected } when canEdit.
 * PATCH  { tier: "standard" | "premium" }: owner of a comped org, or a platform admin for any org.
 *        Managers, trainees and owners of an org that is not comped get 403. Answers like GET.
 *
 * `tier` is always the EFFECTIVE tier, the one the next call actually runs on: Standard unless the org is
 * comped AND premium is selected. `selected` is the stored preference, sent only to people who can change
 * it, because it differs from `tier` only when a platform admin sets Premium on an org that is not comped.
 *
 * Comped gate: a call runs on Premium only when the org is comped (voiceModelComped = true) AND its tier
 * is premium (effectiveVoiceTier). Comped is set by hand in the database; no route here changes it.
 *
 * Not billing: the Stripe Premium Voice add-on (Organization.premiumVoice, TrainerSession.engineTier) is separate
 * and untouched. This only picks the OpenAI Realtime model id at mint time.
 *
 * Platform admins may target another organization with ?org=<code> (GET) or orgCode (PATCH body).
 * Anyone else gets 403 for an org code that isn't their own.
 */

const OrgCode = z.string().trim().regex(/^\d{3,12}$/);
const Patch = z.object({ tier: z.enum(VOICE_TIERS), orgCode: OrgCode.optional() }).strict();

const forbiddenWrite = () =>
  NextResponse.json({ error: "forbidden", message: "Only the team owner can change voice quality. Ask your owner to switch it." }, { status: 403 });
const forbiddenOrg = () =>
  NextResponse.json({ error: "forbidden", message: "You can only see voice quality for your own team." }, { status: 403 });
const localOnly = () =>
  NextResponse.json({ error: "local_only", message: "Demo mode always uses Standard voice. Connect a database to change it." }, { status: 400 });

const ORG_FIELDS = { id: true, code: true, voiceModelTier: true, voiceModelComped: true } as const;

const notComped = () =>
  NextResponse.json({ error: "not_comped", message: "Premium voice quality is not enabled for this team, so calls use Standard. Ask your platform admin to enable it." }, { status: 403 });

/** The organization the request is about: the actor's own, or the one named by code for a platform admin. */
async function targetOrg(actor: Actor, code: string | undefined) {
  if (code) {
    const org = await prisma.organization.findUnique({ where: { code }, select: ORG_FIELDS });
    if (org && org.id === actor.organizationId) return org;
    if (!actor.isPlatformAdmin) return "forbidden" as const;
    return org ?? ("not_found" as const);
  }
  if (!actor.organizationId) return "no_org" as const;
  const org = await prisma.organization.findUnique({ where: { id: actor.organizationId }, select: ORG_FIELDS });
  return org ?? ("no_org" as const);
}

/** Response body for GET and PATCH: the effective tier, and the stored preference only for an editor. */
function voiceView(stored: unknown, comped: boolean, canEdit: boolean) {
  return {
    tier: effectiveVoiceTier(stored, comped),
    comped,
    canEdit,
    ...(canEdit ? { selected: normalizeVoiceTier(stored) } : {}),
  };
}

const orgNotFound = () => NextResponse.json({ error: "not_found", message: "No organization has that code. Check the code and try again." }, { status: 404 });

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return NextResponse.json({ tier: "standard", comped: false, canEdit: false, local: true });
  const limited = limitFor(`team:voice:read:${auth.id}`, 60, 60_000);
  if (limited) return limited;

  const code = OrgCode.optional().safeParse(req.nextUrl.searchParams.get("org") ?? undefined);
  if (!code.success) return NextResponse.json({ error: "invalid_query", message: "org must be an organization code made of digits." }, { status: 400 });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    const org = await targetOrg(actor, code.data);
    if (org === "forbidden") return forbiddenOrg();
    if (org === "not_found") return orgNotFound();
    if (org === "no_org") return noOrganization();
    const comped = org.voiceModelComped === true;
    return NextResponse.json(
      voiceView(storedOrDefaultTier(org.voiceModelTier), comped, canEditVoiceTier(actor.role, actor.isPlatformAdmin, comped)),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[/api/team/voice] GET error:", error instanceof Error ? error.name : "unknown error");
    return serverError("load voice quality");
  }
}

export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const ipLimited = ipLimitResponse(req, "teamSettings");
  if (ipLimited) return ipLimited;
  const limited = limitFor(`team:voice:${auth.id}`, 10, 60_000);
  if (limited) return limited;

  let body: z.infer<typeof Patch>;
  try {
    const parsed = Patch.safeParse(await readJsonLimited(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request", message: "tier must be standard or premium." }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    // Role is read from the database, never from the token or the body.
    if (!canSetVoiceTier(actor.role, actor.isPlatformAdmin)) return forbiddenWrite();
    const org = await targetOrg(actor, body.orgCode);
    if (org === "forbidden") return forbiddenWrite();
    if (org === "not_found") return orgNotFound();
    if (org === "no_org") return noOrganization();
    const comped = org.voiceModelComped === true;
    // An owner can only switch a comped org. A platform admin can set any org's tier; mint still uses Standard until it is comped.
    if (!canEditVoiceTier(actor.role, actor.isPlatformAdmin, comped)) return notComped();

    const from = normalizeVoiceTier(storedOrDefaultTier(org.voiceModelTier));
    // Standard is stored as null, the same as an org that never chose, unless the tenant default is Premium (tierToStore).
    await prisma.organization.update({ where: { id: org.id }, data: { voiceModelTier: tierToStore(body.tier) } });
    await prisma.auditEvent.create({
      data: {
        userId: actor.id,
        action: "org.voice_tier_changed",
        resource: org.id,
        metadata: { from, to: body.tier, comped, byPlatformAdmin: actor.isPlatformAdmin && actor.organizationId !== org.id },
      },
    });
    return NextResponse.json(voiceView(body.tier, comped, true));
  } catch (error) {
    console.error("[/api/team/voice] PATCH error:", error instanceof Error ? error.name : "unknown error");
    return serverError("save voice quality");
  }
}

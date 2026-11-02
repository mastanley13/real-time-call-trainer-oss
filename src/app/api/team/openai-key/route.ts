import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { clientIp, ipLimitResponse, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { BYOK_KEY_PATTERN, byokEncryptionKey, encryptByok, last4Of, type ByokStatus } from "@/lib/byok";
import { billingActive } from "@/lib/serverConfig";
import { isTeamPlan } from "@/lib/usagePlan";
import { loadActor, noOrganization, serverError, teamIsLocal } from "../_lib/server";

/**
 * Team bring-your-own OpenAI key (STR-690). GET shows whether a key is set (last four characters only), PUT stores
 * one encrypted at rest, DELETE clears it. Only an owner of the organization may call it. The key is used only for
 * that team's members while the organization is on the Team plan (openaiKeys.ts). It is never returned, logged or
 * put in the audit trail.
 */

const Body = z.object({ apiKey: z.string().trim().max(300).regex(BYOK_KEY_PATTERN) }).strict();

const fail = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });

const ownersOnly = () => fail(403, "forbidden", "Only an owner of your organization can manage its OpenAI key.");

type OrgKeyRow = { openaiKeyCiphertext: string | null; openaiKeyLast4: string | null; openaiKeyUpdatedAt: Date | null };

const statusOf = (org: OrgKeyRow): ByokStatus => ({
  set: Boolean(org.openaiKeyCiphertext),
  last4: org.openaiKeyCiphertext ? org.openaiKeyLast4 : null,
  updatedAt: org.openaiKeyCiphertext && org.openaiKeyUpdatedAt ? org.openaiKeyUpdatedAt.toISOString() : null,
});

const KEY_SELECT = { openaiKeyCiphertext: true, openaiKeyLast4: true, openaiKeyUpdatedAt: true } as const;

/** Auth, limits and the owner check shared by all three methods. Returns the owner's organization id or a response. */
async function ownerOrg(req: NextRequest, write: boolean): Promise<{ actorId: string; organizationId: string } | Response> {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return fail(400, "byok_unavailable", "This server has no database, so it can't store a team OpenAI key.");
  if (write) {
    const ipLimited = ipLimitResponse(req, "billing");
    if (ipLimited) return ipLimited;
    const userLimited = userLimitResponse(auth.id, "billing");
    if (userLimited) return userLimited;
  }
  const actor = await loadActor(auth.id);
  if (!actor) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!actor.organizationId) return noOrganization();
  if (actor.role !== "owner") return ownersOnly();
  return { actorId: actor.id, organizationId: actor.organizationId };
}

const audit = (req: NextRequest, userId: string, action: string, organizationId: string) =>
  prisma.auditEvent.create({
    data: { userId, action, resource: organizationId, ip: clientIp(req), userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null },
  });

export async function GET(req: NextRequest) {
  const who = await ownerOrg(req, false);
  if (who instanceof Response) return who;
  try {
    const org = await prisma.organization.findUnique({ where: { id: who.organizationId }, select: KEY_SELECT });
    if (!org) return noOrganization();
    return NextResponse.json(statusOf(org), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[team/openai-key] read failed", e instanceof Error ? e.name : "unknown");
    return serverError("load your team's OpenAI key status");
  }
}

export async function PUT(req: NextRequest) {
  const who = await ownerOrg(req, true);
  if (who instanceof Response) return who;

  let apiKey: string;
  try {
    apiKey = Body.parse(await readJsonLimited(req)).apiKey;
  } catch {
    // Never echo the body or zod's issue list back: either could carry the key.
    return fail(400, "invalid_key", "That doesn't look like an OpenAI secret key. Paste the full key that starts with sk-.");
  }

  const encKey = byokEncryptionKey();
  if (!encKey) return fail(503, "byok_not_configured", "This server can't store team keys yet. Ask the server admin to set BYOK_ENCRYPTION_KEY.");

  try {
    const org = await prisma.organization.findUnique({ where: { id: who.organizationId }, select: { id: true, planTier: true } });
    if (!org) return noOrganization();
    if (!(isTeamPlan(org) && billingActive())) {
      return fail(403, "team_plan_required", "Your own OpenAI key is a Team plan feature. Upgrade to Team, then add the key.");
    }
    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: { openaiKeyCiphertext: encryptByok(apiKey, org.id, encKey), openaiKeyLast4: last4Of(apiKey), openaiKeyUpdatedAt: new Date() },
      select: KEY_SELECT,
    });
    await audit(req, who.actorId, "org.openai_key_set", org.id).catch(() => null);
    return NextResponse.json(statusOf(updated), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[team/openai-key] save failed", e instanceof Error ? e.name : "unknown");
    return serverError("save your team's OpenAI key");
  }
}

export async function DELETE(req: NextRequest) {
  const who = await ownerOrg(req, true);
  if (who instanceof Response) return who;
  try {
    const updated = await prisma.organization.update({
      where: { id: who.organizationId },
      data: { openaiKeyCiphertext: null, openaiKeyLast4: null, openaiKeyUpdatedAt: null },
      select: KEY_SELECT,
    });
    await audit(req, who.actorId, "org.openai_key_cleared", who.organizationId).catch(() => null);
    return NextResponse.json(statusOf(updated), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[team/openai-key] clear failed", e instanceof Error ? e.name : "unknown");
    return serverError("remove your team's OpenAI key");
  }
}

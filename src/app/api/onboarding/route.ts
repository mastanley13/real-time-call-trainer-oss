import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { generateOrgCode, personalOrgName } from "@/lib/orgCodes";
import { clientIp, readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { needsOnboarding, orgView, startSession, toSessionUser } from "@/lib/session";
import { teamIsLocal } from "../team/_lib/server";

/**
 * Onboarding for a signed-in user.
 *
 * GET   where they are: org, role, manager, whether onboarding is done
 * POST  { action: "solo" } -> a personal workspace on the Free tier, nothing else to set up
 *       { action: "create_org", name } -> new org, they become its owner
 *       { action: "join_org", code, managerId? } -> join as a rep (optionally on a manager's team)
 *       { action: "finish" } -> mark onboarding done
 * Creating or joining is only for users with no org yet. A role change
 * re-issues the session cookie so the token matches the database.
 */

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("solo") }),
  z.object({ action: z.literal("create_org"), name: z.string().trim().min(2).max(120) }),
  z.object({ action: z.literal("join_org"), code: z.string().regex(/^[0-9]{3,8}$/), managerId: z.string().trim().min(1).max(64).optional() }),
  z.object({ action: z.literal("finish") }),
]);

const localOnly = () =>
  NextResponse.json({ error: "local_only", message: "Demo mode has no accounts, so there is nothing to set up." }, { status: 400 });

async function loadMe(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      organization: { select: { id: true, name: true, code: true, industries: true, isPersonal: true } },
      manager: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });
}
type Me = NonNullable<Awaited<ReturnType<typeof loadMe>>>;

function view(me: Me) {
  return {
    user: { id: me.id, role: me.role, firstName: me.firstName, lastName: me.lastName, isPlatformAdmin: me.isPlatformAdmin },
    organization: me.organization && orgView(me.organization),
    manager: me.manager ? { id: me.manager.id, name: [me.manager.firstName, me.manager.lastName].filter(Boolean).join(" ") || me.manager.email.split("@")[0] } : null,
    needsOnboarding: needsOnboarding(me),
  };
}

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const me = await loadMe(auth.id);
  if (!me) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
  return NextResponse.json(view(me));
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = userLimitResponse(auth.id, "personas");
  if (limited) return limited;

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request", message: "Give your team a name of 2 to 120 characters, or a join code of 3 to 8 digits." }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  try {
    const me = await loadMe(auth.id);
    if (!me) return NextResponse.json({ error: "Unknown user" }, { status: 401 });

    if (body.action === "finish") {
      if (!me.organizationId && !me.isPlatformAdmin) {
        return NextResponse.json({ error: "no_organization", message: "Create or join a team first." }, { status: 400 });
      }
      await prisma.user.update({ where: { id: me.id }, data: { onboardedAt: me.onboardedAt ?? new Date() } });
      return NextResponse.json(view((await loadMe(me.id))!));
    }

    if (me.organizationId) {
      return NextResponse.json({ error: "already_in_org", message: "You're already on a team. Ask an owner if you need to move." }, { status: 409 });
    }

    if (body.action === "solo") {
      const code = await generateOrgCode();
      await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: { name: personalOrgName(me), code, planTier: "free", isPersonal: true },
        });
        await tx.user.update({ where: { id: me.id }, data: { organizationId: org.id, role: "trainee", managerId: null, onboardedAt: me.onboardedAt ?? new Date() } });
        await tx.auditEvent.create({
          data: { userId: me.id, action: "org.created", resource: org.id, ip: clientIp(req), metadata: { via: "onboarding", joinOrCreate: "solo" } satisfies Prisma.InputJsonValue },
        });
      });
    } else if (body.action === "create_org") {
      const code = await generateOrgCode();
      await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({ data: { name: body.name, code } });
        await tx.user.update({ where: { id: me.id }, data: { organizationId: org.id, role: "owner" } });
        await tx.auditEvent.create({
          data: { userId: me.id, action: "org.created", resource: org.id, ip: clientIp(req), metadata: { via: "onboarding" } satisfies Prisma.InputJsonValue },
        });
      });
    } else {
      const org = await prisma.organization.findUnique({ where: { code: body.code }, select: { id: true, isPersonal: true } });
      if (!org || org.isPersonal) return NextResponse.json({ error: "invalid_org_code", message: "No team has that code. Check it with your manager." }, { status: 400 });
      const lead = body.managerId
        ? await prisma.user.findFirst({ where: { id: body.managerId, organizationId: org.id, role: { in: ["manager", "owner"] } }, select: { id: true } })
        : null;
      await prisma.user.update({ where: { id: me.id }, data: { organizationId: org.id, role: "trainee", managerId: lead?.id ?? null } });
      await prisma.auditEvent.create({
        data: { userId: me.id, action: "org.joined", resource: org.id, ip: clientIp(req), metadata: { via: "onboarding", managerId: lead?.id ?? null } },
      });
    }

    const updated = (await loadMe(me.id))!;
    const res = NextResponse.json(view(updated));
    startSession(res, toSessionUser(updated));
    return res;
  } catch (error) {
    console.error("[/api/onboarding] error:", error);
    return NextResponse.json({ error: "server_error", message: "Could not save that. Try again in a minute." }, { status: 500 });
  }
}

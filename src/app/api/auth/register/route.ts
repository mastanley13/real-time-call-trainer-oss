import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { hashPassword, signSessionToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { ACCESS_COOKIE, accessGateEnabled, gateCookieValid, verifyInviteAccessToken } from "@/lib/access";
import { generateOrgCode, isValidOrgCode } from "@/lib/orgCodes";
import { consumeInvite, hashInviteCode, invalidInvite, invitesConfigured, setInviteAccessCookie } from "@/lib/invites";

const RegisterSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().email().max(254),
    phone: z.string().trim().min(7).max(30).optional(),
    password: z
      .string()
      .min(10, "Password must be at least 10 characters")
      .max(200),
    /// Exactly one of these two must be provided.
    joinOrgCode: z.string().regex(/^[0-9]{3,8}$/).optional(),
    newOrgName: z.string().trim().min(2).max(120).optional(),
    /// Optional invite code. Without one, an invite gate cookie (from /access) is used.
    inviteCode: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (v) => !!v.joinOrgCode !== !!v.newOrgName,
    "Either joinOrgCode or newOrgName must be provided (but not both).",
  );

export async function POST(request: NextRequest) {
  // Read once; validated against the schema below, after the gate and the rate limit.
  let raw: unknown;
  let rawOk = true;
  try {
    raw = await request.json();
  } catch {
    rawOk = false;
  }

  // While the access gate is on, signup needs a gate pass: the shared-code cookie (while the shared code is
  // allowed), a signed invite cookie from /access, or an explicit invite code (checked and used up below).
  const gateCookie = request.cookies.get(ACCESS_COOKIE)?.value ?? "";
  const explicitInvite = typeof (raw as { inviteCode?: unknown } | null)?.inviteCode === "string" && Boolean((raw as { inviteCode: string }).inviteCode.trim());
  const gatePassed = !accessGateEnabled() || (await gateCookieValid(gateCookie));
  if (!gatePassed && !explicitInvite) {
    return NextResponse.json({ error: "invite code required" }, { status: 403 });
  }

  const limit = rateLimit({
    key: `register:${clientIp(request)}`,
    limit: 5,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(limit.retryAfterMs / 1000).toString() },
      },
    );
  }

  let body;
  try {
    if (!rawOk) throw new Error("invalid JSON");
    body = RegisterSchema.parse(raw);
  } catch (e) {
    const issues =
      e instanceof z.ZodError ? e.issues.map((i) => i.message).join(", ") : "";
    return NextResponse.json(
      { error: issues || "Invalid registration data" },
      { status: 400 },
    );
  }

  const emailLower = body.email.toLowerCase();

  if (body.inviteCode && !invitesConfigured()) {
    return NextResponse.json(
      { error: "invites_not_configured", message: "Invite codes need a database. Leave the invite code empty." },
      { status: 503 },
    );
  }

  try {
    // Invite attribution: an explicit code wins, else the invite the gate cookie was issued for.
    let inviteId: string | null = null;
    let inviteVia: "code" | "access_cookie" | null = null;
    let inviteExpiresAt: Date | null = null;
    if (body.inviteCode) {
      const invite = await prisma.inviteCode.findUnique({ where: { codeHash: hashInviteCode(body.inviteCode) }, select: { id: true, expiresAt: true } });
      if (!invite) return invalidInvite();
      inviteId = invite.id;
      inviteVia = "code";
      inviteExpiresAt = invite.expiresAt;
    } else if (invitesConfigured()) {
      inviteId = await verifyInviteAccessToken(gateCookie);
      if (inviteId) inviteVia = "access_cookie";
    }

    const existing = await prisma.user.findUnique({ where: { email: emailLower } });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 },
      );
    }

    const hashedPassword = await hashPassword(body.password);

    const { user, organization } = await prisma.$transaction(async (tx) => {
      let orgId: string;
      let role: "owner" | "trainee";

      if (body.newOrgName) {
        const code = await generateOrgCode();
        const org = await tx.organization.create({
          data: { name: body.newOrgName, code },
        });
        orgId = org.id;
        role = "owner";
      } else if (body.joinOrgCode && isValidOrgCode(body.joinOrgCode)) {
        const org = await tx.organization.findUnique({
          where: { code: body.joinOrgCode },
        });
        if (!org) {
          throw new Error("INVALID_ORG_CODE");
        }
        orgId = org.id;
        role = "trainee";
      } else {
        throw new Error("INVALID_REQUEST");
      }

      // Takes one redemption atomically; a revoked, expired or used-up invite rolls the signup back.
      if (inviteId && !(await consumeInvite(tx, inviteId))) {
        throw new Error("INVALID_INVITE");
      }

      const created = await tx.user.create({
        data: {
          email: emailLower,
          passwordHash: hashedPassword,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          organizationId: orgId,
          role,
          inviteCodeId: inviteId,
          lastLoginAt: new Date(),
        },
        include: { organization: true },
      });

      await tx.auditEvent.create({
        data: {
          userId: created.id,
          action: "user.registered",
          resource: created.id,
          ip: clientIp(request),
          userAgent: request.headers.get("user-agent") ?? undefined,
          metadata: {
            role,
            organizationCode: created.organization?.code ?? null,
            joinOrCreate: body.newOrgName ? "create" : "join",
            inviteCodeId: inviteId,
          } satisfies Prisma.InputJsonValue,
        },
      });

      if (inviteId) {
        await tx.auditEvent.create({
          data: { userId: created.id, action: "invite.redeemed", resource: inviteId, ip: clientIp(request), metadata: { via: inviteVia } },
        });
      }

      return { user: created, organization: created.organization };
    });

    const sessionUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      role: user.role as "trainee" | "manager" | "owner",
    };
    const token = signSessionToken(sessionUser);

    const res = NextResponse.json({
      user: {
        ...sessionUser,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      organization: organization
        ? { id: organization.id, name: organization.name, code: organization.code }
        : null,
      token,
    });
    res.cookies.set("authToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    // Signed up with an explicit invite code but no gate pass yet: hand out the invite's gate cookie, so the new
    // account can reach the rest of the site.
    if (inviteId && inviteVia === "code" && !gatePassed) {
      await setInviteAccessCookie(res, { id: inviteId, expiresAt: inviteExpiresAt });
    }
    return res;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_INVITE") {
      return invalidInvite();
    }
    if (error instanceof Error && error.message === "INVALID_ORG_CODE") {
      return NextResponse.json(
        { error: "Unknown organization code." },
        { status: 400 },
      );
    }
    console.error("Registration API error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 },
    );
  }
}

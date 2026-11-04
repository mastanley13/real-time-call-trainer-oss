import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { hashPassword, signSessionToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { accessCode, hasValidAccessCookie } from "@/lib/access";
import { generateOrgCode, isValidOrgCode } from "@/lib/orgCodes";
import { sanitizeSignupIntent } from "@/lib/pricing";
import { emailsMatch, INVITE_TOKEN_RE, inviteStatus } from "@/lib/invites";
import { hashInviteToken } from "@/lib/inviteToken";

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
    /// Exactly one of these three must be provided. An invite signs up with no organization; the invite page
    /// then joins the team through /api/invites/accept, which checks seats.
    joinOrgCode: z.string().regex(/^[0-9]{3,8}$/).optional(),
    newOrgName: z.string().trim().min(2).max(120).optional(),
    inviteToken: z.string().regex(INVITE_TOKEN_RE).optional(),
    /// Sign-up link context. Never rejects the request: bad values are dropped by sanitizeSignupIntent below.
    plan: z.unknown().optional(),
    interval: z.unknown().optional(),
    src: z.unknown().optional(),
    seg: z.unknown().optional(),
  })
  .refine(
    (v) => [v.joinOrgCode, v.newOrgName, v.inviteToken].filter(Boolean).length === 1,
    "Either joinOrgCode or newOrgName must be provided (but not both).",
  );

export async function POST(request: NextRequest) {
  const code = accessCode();
  if (code && !(await hasValidAccessCookie(request, code))) {
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
    body = RegisterSchema.parse(await request.json());
  } catch (e) {
    const issues =
      e instanceof z.ZodError ? e.issues.map((i) => i.message).join(", ") : "";
    return NextResponse.json(
      { error: issues || "Invalid registration data" },
      { status: 400 },
    );
  }

  const emailLower = body.email.toLowerCase();
  const intent = sanitizeSignupIntent(body);

  try {
    const existing = await prisma.user.findUnique({ where: { email: emailLower } });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 },
      );
    }

    const hashedPassword = await hashPassword(body.password);

    const { user, organization } = await prisma.$transaction(async (tx) => {
      let orgId: string | null;
      let role: "owner" | "trainee";

      if (body.inviteToken) {
        // Only for an open invite to this same address, so the invite path cannot make orgless accounts at will.
        const invite = await tx.teamInvite.findUnique({ where: { tokenHash: hashInviteToken(body.inviteToken) } });
        if (!invite || inviteStatus(invite, new Date()) !== "pending" || !emailsMatch(invite.email, emailLower)) {
          throw new Error("INVALID_INVITE");
        }
        orgId = null;
        role = "trainee";
      } else if (body.newOrgName) {
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

      const created = await tx.user.create({
        data: {
          email: emailLower,
          passwordHash: hashedPassword,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          organizationId: orgId,
          role,
          lastLoginAt: new Date(),
          signupPlanIntent: intent.plan,
          signupInterval: intent.interval,
          signupSrc: intent.src,
          signupSeg: intent.seg,
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
            joinOrCreate: body.inviteToken ? "invite" : body.newOrgName ? "create" : "join",
          } satisfies Prisma.InputJsonValue,
        },
      });

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
    return res;
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_ORG_CODE") {
      return NextResponse.json(
        { error: "Unknown organization code." },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message === "INVALID_INVITE") {
      return NextResponse.json(
        { error: "This invite is not valid for this email. Use the address the invite was sent to, or ask the team owner for a new link." },
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

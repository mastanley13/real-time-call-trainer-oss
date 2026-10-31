import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { hashPassword, signSessionToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { generateOrgCode, isValidOrgCode, personalOrgName } from "@/lib/orgCodes";

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
    /// At most one of these two. Neither means a solo sign-up with a personal workspace.
    joinOrgCode: z.string().regex(/^[0-9]{3,8}$/).optional(),
    newOrgName: z.string().trim().min(2).max(120).optional(),
    /// From a manager's invite link: put the new rep on that manager's team.
    managerId: z.string().trim().min(1).max(64).optional(),
  })
  .refine(
    (v) => !(v.joinOrgCode && v.newOrgName),
    "Provide either joinOrgCode or newOrgName, not both.",
  );

export async function POST(request: NextRequest) {
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
  const existing = await prisma.user.findUnique({ where: { email: emailLower } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 },
    );
  }

  try {
    const hashedPassword = await hashPassword(body.password);

    const { user, organization, solo } = await prisma.$transaction(async (tx) => {
      let orgId: string;
      let role: "owner" | "trainee";
      let managerId: string | null = null;
      let solo = false;

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
        // A personal workspace is never joinable, so its code behaves like an unknown one.
        if (!org || org.isPersonal) {
          throw new Error("INVALID_ORG_CODE");
        }
        orgId = org.id;
        role = "trainee";
        if (body.managerId) {
          // Ignored unless the invite names a manager or owner of the same org.
          const lead = await tx.user.findFirst({
            where: { id: body.managerId, organizationId: org.id, role: { in: ["manager", "owner"] } },
            select: { id: true },
          });
          managerId = lead?.id ?? null;
        }
      } else if (body.joinOrgCode) {
        throw new Error("INVALID_ORG_CODE");
      } else {
        const org = await tx.organization.create({
          data: {
            name: personalOrgName({ firstName: body.firstName, lastName: body.lastName, email: emailLower }),
            code: await generateOrgCode(),
            planTier: "free",
            isPersonal: true,
          },
        });
        orgId = org.id;
        role = "trainee";
        solo = true;
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
          managerId,
          // Nothing to set up for a solo account, so it skips onboarding.
          ...(solo ? { onboardedAt: new Date() } : {}),
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
            joinOrCreate: solo ? "solo" : body.newOrgName ? "create" : "join",
          } satisfies Prisma.InputJsonValue,
        },
      });

      return { user: created, organization: created.organization, solo };
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
        ? {
            id: organization.id,
            name: organization.name,
            // A personal workspace has no code to share.
            code: organization.isPersonal ? null : organization.code,
            isPersonal: organization.isPersonal,
          }
        : null,
      token,
      needsOnboarding: !solo,
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
    console.error("Registration API error:", error);
    return NextResponse.json(
      { error: "Registration failed. Please try again." },
      { status: 500 },
    );
  }
}

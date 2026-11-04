import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { getCapabilities } from "@/lib/serverConfig";

/**
 * Hands the browser the session that Google sign-in put in the httpOnly cookie, in the same shape the password
 * login returns, so the client can restore its signed-in state. Role and org come from the database.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (getCapabilities().demoMode) {
    return NextResponse.json({ error: "demo_mode", message: "Demo mode has no sessions." }, { status: 400 });
  }
  const token = req.cookies.get("authToken")?.value;
  if (!token) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: auth.id }, include: { organization: true } });
  if (!user) return NextResponse.json({ error: "Unknown user" }, { status: 401 });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      role: user.role as "trainee" | "manager" | "owner",
      isPlatformAdmin: user.isPlatformAdmin,
    },
    organization: user.organization
      ? { id: user.organization.id, name: user.organization.name, code: user.organization.code }
      : null,
    token,
  });
}

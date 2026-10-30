import "server-only";
import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { isDemoUser } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";

export const adminForbidden = () =>
  NextResponse.json({ error: "forbidden", message: "Only platform admins can manage invite codes." }, { status: 403 });

/**
 * The signed-in user as stored, if they are a platform admin. The flag is read
 * from the database, never from the session token, and the demo user is never an admin.
 * Returns the admin's id, or a 401/403 response.
 */
export async function requirePlatformAdmin(auth: SessionUser): Promise<{ id: string } | NextResponse> {
  if (isDemoUser(auth)) return adminForbidden();
  const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { id: true, isPlatformAdmin: true } });
  if (!user) return NextResponse.json({ error: "unknown_user", message: "Sign in again and retry." }, { status: 401 });
  if (!user.isPlatformAdmin) return adminForbidden();
  return { id: user.id };
}

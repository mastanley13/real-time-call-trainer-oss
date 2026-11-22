import "server-only";
import { getJwtSecret } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fingerprintMatches, RESET_TOKEN_MAX_LENGTH, verifyResetToken } from "@/lib/passwordReset";

export interface ResetTokenUser {
  id: string;
  passwordHash: string | null;
}

/**
 * The one check behind both /api/auth/password-reset/check and /confirm, so the page-load check can never be weaker
 * than the submit. Returns the user the link is for when the signature is valid, it has not expired, the user exists
 * and the password has not changed since the link was issued; else null. Reads only, writes nothing.
 */
export async function checkResetToken(token: string): Promise<ResetTokenUser | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > RESET_TOKEN_MAX_LENGTH) return null;
  const secret = getJwtSecret();
  const claims = verifyResetToken(token, { secret, now: Date.now() });
  if (!claims) return null;

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user || !fingerprintMatches(claims.fingerprint, user.passwordHash, secret)) return null;
  return user;
}

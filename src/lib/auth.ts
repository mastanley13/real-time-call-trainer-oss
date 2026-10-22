import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export type SessionRole = "trainee" | "manager" | "owner" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: SessionRole;
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET is not configured. Set a 32+ byte random value in env before starting the server.",
    );
  }
  return secret;
}

export function signSessionToken(user: SessionUser): string {
  return jwt.sign(user, getJwtSecret(), { expiresIn: "12h" });
}

export function verifySessionToken(token: string): SessionUser | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    if (!payload || typeof payload !== "object" || !payload.id || !payload.email) {
      return null;
    }
    return {
      id: String(payload.id),
      email: String(payload.email),
      firstName: payload.firstName as string | undefined,
      lastName: payload.lastName as string | undefined,
      role: (payload.role as SessionRole) || "trainee",
    };
  } catch {
    return null;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function signMfaChallengeToken(userId: string): string {
  return jwt.sign(
    { id: userId, purpose: "mfa-challenge" },
    getJwtSecret(),
    { expiresIn: "5m" },
  );
}

export function verifyMfaChallengeToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload;
    if (!payload || payload.purpose !== "mfa-challenge" || !payload.id) {
      return null;
    }
    return String(payload.id);
  } catch {
    return null;
  }
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  // Only bcrypt hashes are accepted. Plaintext comparison is never performed.
  if (!/^\$2[aby]\$/.test(hash)) return { ok: false, needsRehash: false };
  return { ok: await bcrypt.compare(plain, hash), needsRehash: false };
}

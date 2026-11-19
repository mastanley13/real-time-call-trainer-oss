import "server-only";
import * as OTPAuth from "otpauth";
import crypto from "crypto";

const ISSUER = "Real-Time Call Trainer";
export const TOTP_PERIOD_SEC = 30;

export function generateMfaSecret(): string {
  // 20 random bytes, base32-encoded, is the standard TOTP secret size.
  // Use otpauth's own RNG so we don't fight Node's Uint8Array<ArrayBuffer>
  // vs ArrayBufferLike typing.
  return new OTPAuth.Secret({ size: 20 }).base32;
}
// crypto import retained in case helpers need it later
void crypto;

export function buildProvisioningUri(params: {
  label: string;
  secret: string;
}): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: params.label,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SEC,
    secret: OTPAuth.Secret.fromBase32(params.secret),
  });
  return totp.toString();
}

/**
 * Returns the accepted TOTP time-step (floor(unixMs / 1000 / 30)), or null if
 * the code is invalid. A one-step clock drift in either direction is allowed.
 */
export function verifyTotp(secret: string, token: string, atMs = Date.now()): number | null {
  if (!/^[0-9]{6}$/.test(token)) return null;
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SEC,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token, window: 1, timestamp: atMs });
  if (delta === null) return null;
  return totp.counter({ timestamp: atMs }) + delta;
}

/** Records `step` as the last accepted TOTP step. Returns false when that step (or a later one) was already used. */
export async function claimTotpStep(
  db: {
    user: {
      updateMany: (args: {
        where: Record<string, unknown>;
        data: { mfaLastTotpStep: number };
      }) => Promise<{ count: number }>;
    };
  },
  userId: string,
  step: number,
  extraWhere: Record<string, unknown> = {},
): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: {
      id: userId,
      ...extraWhere,
      OR: [{ mfaLastTotpStep: null }, { mfaLastTotpStep: { lt: step } }],
    },
    data: { mfaLastTotpStep: step },
  });
  return count === 1;
}

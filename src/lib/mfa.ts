import "server-only";
import * as OTPAuth from "otpauth";
import crypto from "crypto";
import { NextResponse } from "next/server";
import { getCapabilities } from "@/lib/serverConfig";

const ISSUER = "Real-Time Call Trainer";

/**
 * MFA protects stored accounts. Demo mode and database-free installs have none, so the signed-in MFA routes answer
 * with this 503 instead of reaching for a database that is not there. Returns null when MFA is available.
 */
export function mfaUnavailableResponse(): NextResponse | null {
  const caps = getCapabilities();
  if (!caps.demoMode && caps.database) return null;
  return NextResponse.json(
    {
      error: "mfa_not_available",
      message: "MFA needs stored accounts. Set DATABASE_URL and turn off DEMO_MODE to use it.",
    },
    { status: 503 },
  );
}

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
    period: 30,
    secret: OTPAuth.Secret.fromBase32(params.secret),
  });
  return totp.toString();
}

export function verifyTotp(secret: string, token: string): boolean {
  if (!/^[0-9]{6}$/.test(token)) return false;
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  // Allow a one-step clock drift in either direction.
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

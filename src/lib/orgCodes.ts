import "server-only";
import { randomInt } from "node:crypto";
import { prisma } from "./db";

/**
 * Generate a unique 6-digit organization code.
 *
 * 900,000 possible codes, drawn from a CSPRNG. Codes are stored as strings;
 * legacy 3-digit codes remain valid.
 */
export async function generateOrgCode(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = randomInt(100000, 1000000);
    const code = String(n);
    const exists = await prisma.organization.findUnique({ where: { code } });
    if (!exists) return code;
  }
  throw new Error("Failed to allocate a unique org code — code space exhausted.");
}

export function isValidOrgCode(code: unknown): code is string {
  return typeof code === "string" && /^[0-9]{3,8}$/.test(code);
}

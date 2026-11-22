import "server-only";
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { RECOVERY_CODE_COUNT } from "@/lib/mfaRecovery-types";

/**
 * MFA recovery codes. Ten single-use codes per account, issued when TOTP is activated and on every regeneration.
 *
 * Format: 12 characters from a 32-symbol alphabet with no 0, 1, I or O (so nothing reads as another symbol),
 * shown as xxxx-xxxx-xxxx. Each character carries 5 bits from crypto.randomBytes, so a code has 60 bits of entropy.
 *
 * Only a hash is stored. SHA-256 of the normalized code is enough here, and a slow password hash (bcrypt) is not
 * needed: these are server-generated uniform random values, not human-chosen passwords, so there is no dictionary
 * to try and an offline attacker holding the table still faces about 2^60 guesses per code. A fast, unsalted,
 * deterministic hash also lets the database find and spend a code in one conditional UPDATE on a unique column.
 */

export const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_CHARS = 12;
const GROUP = 4;
/** Entropy per code: 5 bits for each of the 12 characters. */
export const RECOVERY_CODE_BITS = CODE_CHARS * Math.log2(RECOVERY_ALPHABET.length);

const NORMALIZED = /^[2-9A-HJ-NP-Z]{12}$/;
// Whitespace and any dash punctuation (\p{Pd}: hyphen-minus plus the Unicode hyphens and dashes that some editors
// substitute when pasting).
const SEPARATORS = /[\s\p{Pd}]/gu;

function group(raw: string): string {
  return raw.match(new RegExp(`.{1,${GROUP}}`, "g"))!.join("-");
}

/** One code, formatted xxxx-xxxx-xxxx. */
export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(CODE_CHARS);
  let raw = "";
  // The alphabet has 32 symbols and 256 is a multiple of 32, so masking the low 5 bits has no modulo bias.
  for (const b of bytes) raw += RECOVERY_ALPHABET[b & 31];
  return group(raw);
}

/** A fresh set of distinct codes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/**
 * Canonical form for hashing: upper case, with spaces and dashes removed. Returns null when the result cannot be a
 * recovery code (wrong length or a character outside the alphabet), so callers can refuse it without a lookup.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.normalize("NFKC").toUpperCase().replace(SEPARATORS, "");
  return NORMALIZED.test(s) ? s : null;
}

/** Hex SHA-256 of a normalized code. The only form that is ever stored. */
export function hashRecoveryCode(normalized: string): string {
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

type Tx = Prisma.TransactionClient;

/**
 * What the caller verified before the transaction. `mfaSecret` is the enrollment the proof (or activation) was checked
 * against; `passwordHash`, when present, is the hash a password proof was checked against.
 */
export type ProvenState = { mfaSecret: string; passwordHash?: string | null };

/**
 * Inside a transaction: lock the user row, recheck that MFA is still on with the same secret (and, for a password
 * proof, the same password hash) that the caller verified, then delete every existing code and store hashes of a new
 * set. Returns the plaintext codes (for the one response that shows them), or null and writes nothing when the
 * account changed after the proof was checked: MFA turned off, re-enrolled with a new secret, or a new password. The
 * row lock serializes this with other regenerations and with disable, so two overlapping requests never leave both
 * sets live.
 */
export async function replaceRecoveryCodes(tx: Tx, userId: string, proven: ProvenState): Promise<string[] | null> {
  const rows = await tx.$queryRaw<{ mfaEnabled: boolean; mfaSecret: string | null; passwordHash: string | null }[]>`
    SELECT "mfaEnabled", "mfaSecret", "passwordHash" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  const now = rows[0];
  if (!now?.mfaEnabled || now.mfaSecret !== proven.mfaSecret) return null;
  if (proven.passwordHash !== undefined && now.passwordHash !== proven.passwordHash) return null;
  const codes = generateRecoveryCodes();
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(code)!) })),
  });
  return codes;
}

export type ConsumeResult = { ok: true; remaining: number } | { ok: false };

/**
 * Spend one recovery code. The code is matched and marked used by a single conditional UPDATE (`usedAt IS NULL`),
 * so two concurrent requests with the same code cannot both succeed: the loser's update matches no row and gets
 * count 0. The comparison happens in the database by unique hash; no hash is compared in application memory.
 * Pass a transaction client so the spend commits or rolls back together with the sign-in it pays for.
 */
export async function consumeRecoveryCode(userId: string, input: string, db: Tx = prisma): Promise<ConsumeResult> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return { ok: false };
  const spent = await db.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(normalized), usedAt: null },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) return { ok: false };
  const remaining = await db.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  return { ok: true, remaining };
}

/** Unused and issued counts for the settings page. `total` is 0 for accounts that enabled MFA before codes existed. */
export async function recoveryCodeCounts(userId: string): Promise<{ remaining: number; total: number }> {
  const [remaining, total] = await Promise.all([
    prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    prisma.mfaRecoveryCode.count({ where: { userId } }),
  ]);
  return { remaining, total };
}

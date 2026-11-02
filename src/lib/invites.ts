import "server-only";
import { createHash, randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ACCESS_COOKIE, INVITE_ACCESS_MAX_AGE, inviteAccessToken } from "./access";
import { getCapabilities } from "./serverConfig";

/**
 * Per-person invite codes (STR-686). Only a SHA-256 hash of a code is stored.
 * Codes are 100 bits of randomness, so an unkeyed hash is enough and stays
 * valid if JWT_SECRET is rotated.
 */

/** Crockford base32 without I, L, O, U: easy to read aloud and type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 20;

/** A new plain code, e.g. `7KQ2-9XAB-M4TR-HZ0C-W5NP`. Show it once; store only `hashInviteCode(code)`. */
export function generateInviteCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_CHARS; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join("-");
}

/** Uppercases and drops spaces and dashes, so `7kq2 9xab-...` matches `7KQ2-9XAB-...`. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "");
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(`trainer-invite-code:${normalizeInviteCode(code)}`).digest("hex");
}

/** Invites need the database; demo mode and database-less installs answer 503. */
export function invitesConfigured(): boolean {
  const caps = getCapabilities();
  return caps.database && !caps.demoMode;
}

export const invitesNotConfigured = () =>
  NextResponse.json(
    { error: "invites_not_configured", message: "Invite codes need a database. Set DATABASE_URL on the server, or use the shared access code." },
    { status: 503 },
  );

export const invalidInvite = () =>
  NextResponse.json({ error: "invalid_invite", message: "That invite code isn't valid. Check it, or ask for a new one." }, { status: 400 });

export interface InviteLimits {
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export type InviteStatus = "active" | "revoked" | "expired" | "exhausted";

export function inviteStatus(invite: InviteLimits, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) return "expired";
  if (invite.maxRedemptions !== null && invite.redemptionCount >= invite.maxRedemptions) return "exhausted";
  return "active";
}

type Db = Pick<PrismaClient, "inviteCode"> | Prisma.TransactionClient;

/**
 * Takes one redemption, atomically: the row is updated only while it is still
 * unrevoked, unexpired and under its cap, so two people racing for the last
 * slot can't both win. Returns false when nothing was updated.
 */
export async function consumeInvite(db: Db, inviteId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.inviteCode.updateMany({
    where: {
      id: inviteId,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ maxRedemptions: null }, { redemptionCount: { lt: db.inviteCode.fields.maxRedemptions } }] },
      ],
    },
    data: { redemptionCount: { increment: 1 } },
  });
  return count === 1;
}

/** Sets the gate cookie for an invite. Returns false when no cookie could be signed (no usable JWT_SECRET). */
export async function setInviteAccessCookie(res: NextResponse, invite: { id: string; expiresAt: Date | null }, nowMs = Date.now()): Promise<boolean> {
  const cap = nowMs + INVITE_ACCESS_MAX_AGE * 1000;
  const until = invite.expiresAt ? Math.min(cap, invite.expiresAt.getTime()) : cap;
  const token = await inviteAccessToken(invite.id, Math.floor(until / 1000));
  if (!token) return false;
  res.cookies.set(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(1, Math.floor((until - nowMs) / 1000)),
  });
  return true;
}

/** Fields an admin list may show. Never the hash, never a code. */
export const INVITE_PUBLIC_SELECT = {
  id: true,
  label: true,
  maxRedemptions: true,
  redemptionCount: true,
  expiresAt: true,
  revokedAt: true,
  minuteQuota: true,
  createdById: true,
  createdAt: true,
} as const;

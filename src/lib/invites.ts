/**
 * Team invites and members: the shared contract and the pure rules. Client-safe, so the Members page and the
 * routes use the same seat math and copy. Token creation and hashing live in inviteToken.ts (server only).
 */
import { z } from "zod";
import type { TeamRole } from "./team";

export const INVITE_TTL_MS = 7 * 86_400_000;
export const MAX_INVITES_PER_REQUEST = 20;
export const INVITE_ROLES = ["trainee", "manager"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];
export const INVITE_ROLE_LABEL: Record<InviteRole, string> = { trainee: "Rep", manager: "Manager" };

/** The raw token: 32 random bytes as base64url, always 43 characters. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const TokenBodySchema = z.object({ token: z.string().regex(INVITE_TOKEN_RE) });
export const isInviteToken = (s: string | null | undefined): s is string => !!s && INVITE_TOKEN_RE.test(s);

/** The token in an "/invite/<token>" path (a sign-in ?next= value), or null. */
export function inviteTokenFromPath(path: string | null | undefined): string | null {
  const m = path?.match(/^\/invite\/([A-Za-z0-9_-]{43})$/);
  return m ? m[1] : null;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailsMatch = (a: string, b: string) => normalizeEmail(a) === normalizeEmail(b);

export const InviteCreateSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(MAX_INVITES_PER_REQUEST),
  role: z.enum(INVITE_ROLES).default("trainee"),
});
export type InviteCreateInput = z.infer<typeof InviteCreateSchema>;

/** Splits what was typed in the invite box on commas, semicolons and whitespace. Lowercased, deduplicated. */
export function parseEmailList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean))];
}

export const looksLikeEmail = (s: string) => z.string().email().max(254).safeParse(s).success;

export type InviteStatus = "pending" | "expired" | "accepted" | "revoked";

type When = Date | string | null | undefined;
const time = (v: When) => (v ? new Date(v).getTime() : null);

export function inviteStatus(i: { acceptedAt?: When; revokedAt?: When; expiresAt: Date | string }, now: Date): InviteStatus {
  if (time(i.acceptedAt) !== null) return "accepted";
  if (time(i.revokedAt) !== null) return "revoked";
  return time(i.expiresAt)! > now.getTime() ? "pending" : "expired";
}

export const inviteExpiry = (now: Date) => new Date(now.getTime() + INVITE_TTL_MS);

/** Seats in use: active members plus pending, unexpired invites. Expired and revoked invites free their seat. */
export interface SeatUsage { members: number; pending: number; seatCount: number }
export const seatsUsed = (s: SeatUsage) => s.members + s.pending;
export const seatsLeft = (s: SeatUsage) => Math.max(0, s.seatCount - seatsUsed(s));
/** True when `adding` more people (new invites, or a revived expired one) still fits. */
export const fitsSeats = (s: SeatUsage, adding: number) => seatsUsed(s) + adding <= s.seatCount;

/** The page renders "Add seats from Billing" as a link to /settings/billing, so the lead is exported on its own. */
export const seatsFullLead = (seatCount: number) => `All ${seatCount} ${seatCount === 1 ? "seat is" : "seats are"} in use.`;
export const seatsFullMessage = (seatCount: number) => `${seatsFullLead(seatCount)} Add seats from Billing to invite more people.`;
export const seatSummary = (used: number, total: number) => `${used} of ${total} ${total === 1 ? "seat" : "seats"} used`;

/**
 * What the actor may do on the Members page. Owners and managers can see it; only an owner of a Team-plan
 * organization can invite, resend, revoke or remove.
 */
export type MembersAccess = "manage" | "view" | "not_team_plan" | "forbidden" | "no_organization";
export function membersAccess(actor: { role: string; organizationId: string | null }, org: { planTier: string } | null): MembersAccess {
  if (!actor.organizationId || !org) return "no_organization";
  if (actor.role !== "owner" && actor.role !== "manager") return "forbidden";
  if (org.planTier !== "team") return "not_team_plan";
  return actor.role === "owner" ? "manage" : "view";
}

/** Why a member cannot be removed, or null when they can. */
export function removeBlock(actorId: string, target: { id: string; role: string }, owners: number): "self" | "last_owner" | null {
  if (target.id === actorId) return "self";
  if (target.role === "owner" && owners <= 1) return "last_owner";
  return null;
}

/**
 * Why this account cannot join the invite's organization, or null. Leaving an organization where they are the
 * only owner and others remain would strand that team, so it is refused until they hand over ownership.
 */
export function joinBlock(
  user: { organizationId: string | null; role: string },
  inviteOrgId: string,
  currentOrg: { otherMembers: number; otherOwners: number } | null,
): "already_member" | "sole_owner" | null {
  if (user.organizationId === inviteOrgId) return "already_member";
  if (user.organizationId && user.role === "owner" && currentOrg && currentOrg.otherMembers > 0 && currentOrg.otherOwners === 0) return "sole_owner";
  return null;
}

/** "mia@example.test" becomes "m**@example.test", for telling someone which address an invite is for. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export interface MemberView { id: string; name: string; email: string; role: TeamRole; joinedAt: string }
export interface InviteView { id: string; email: string; role: InviteRole; status: "pending" | "expired"; expiresAt: string; sentAt: string }

export interface MembersPayload {
  org: { name: string; seatCount: number; planTier: string };
  access: MembersAccess;
  viewerId: string;
  members: MemberView[];
  invites: InviteView[];
  seats: { used: number; total: number };
  /** Demo mode: made-up data, and nothing is saved. */
  sample?: boolean;
}

/** What the invite page shows a signed-in person before they accept. */
export interface InvitePreview {
  teamName: string;
  role: InviteRole;
  expiresAt: string;
  /** False when the signed-in account's email is not the invited one; `invitedEmail` is then masked. */
  emailMatches: boolean;
  invitedEmail?: string;
  alreadyMember: boolean;
  sample?: boolean;
}

/** Pending first, then expired; newest first within each. */
export function sortInvites<T extends { status: "pending" | "expired"; sentAt: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.status === b.status ? b.sentAt.localeCompare(a.sentAt) : a.status === "pending" ? -1 : 1));
}

/** Seat usage as the page shows it, recomputed after local edits so the summary never lags the lists. */
export function payloadSeats(p: Pick<MembersPayload, "members" | "invites" | "org">) {
  return { used: p.members.length + p.invites.filter((i) => i.status === "pending").length, total: p.org.seatCount };
}

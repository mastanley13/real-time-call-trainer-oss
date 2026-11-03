/**
 * Who can see and manage whom inside an organization.
 *
 * Pure functions only, shared by the team routes, the transcript and notes
 * routes, and the tests. The model: a rep (trainee) reports to at most one
 * manager through `managerId`. Owners and platform admins see the whole org;
 * a manager sees only themselves and the reps that report to them.
 */
import { z } from "zod";

export type ScopeRole = "trainee" | "manager" | "owner";

export interface ScopeActor {
  id: string;
  role: string;
  isPlatformAdmin: boolean;
  organizationId: string | null;
}

export interface ScopeMember {
  id: string;
  role: string;
  organizationId: string | null;
  managerId: string | null;
}

/** Owners and platform admins see everyone in their org. */
export function seesWholeOrg(actor: Pick<ScopeActor, "role" | "isPlatformAdmin">): boolean {
  return actor.isPlatformAdmin || actor.role === "owner";
}

/**
 * Whether `actor` may read `target`'s sessions and notes. Platform admins can
 * read anyone; everyone can read themselves; owners read their org; managers
 * read the reps that report to them.
 */
export function canSeeMember(actor: ScopeActor, target: Pick<ScopeMember, "id" | "organizationId" | "managerId">): boolean {
  if (actor.isPlatformAdmin) return true;
  if (actor.id === target.id) return true;
  if (!actor.organizationId || actor.organizationId !== target.organizationId) return false;
  if (actor.role === "owner") return true;
  return actor.role === "manager" && target.managerId === actor.id;
}

/** Whether `actor` may coach (write notes on) `target`. Same as seeing them, minus yourself unless you manage. */
export function canCoachMember(actor: ScopeActor, target: Pick<ScopeMember, "id" | "organizationId" | "managerId">): boolean {
  if (actor.role !== "manager" && actor.role !== "owner" && !actor.isPlatformAdmin) return false;
  return canSeeMember(actor, target);
}

/** The members a manager-level actor sees in the team view, in input order. */
export function membersInScope<T extends Pick<ScopeMember, "id" | "managerId">>(
  actor: Pick<ScopeActor, "id" | "role" | "isPlatformAdmin">,
  members: T[],
  managerFilter?: string | null,
): T[] {
  if (seesWholeOrg(actor)) {
    if (!managerFilter) return members;
    return members.filter((m) => m.id === managerFilter || m.managerId === managerFilter);
  }
  return members.filter((m) => m.id === actor.id || m.managerId === actor.id);
}

// ─── Roster changes ───────────────────────────────────────────────────────

export const MemberChangeSchema = z
  .object({
    role: z.enum(["trainee", "manager"]).optional(),
    /** Null removes the rep from their manager. */
    managerId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((v) => v.role !== undefined || v.managerId !== undefined, "Send a role or a managerId to change.");
export type MemberChange = z.infer<typeof MemberChangeSchema>;

export type ChangeCheck = { ok: true } | { ok: false; status: 400 | 403; error: string; message: string };

const deny = (message: string): ChangeCheck => ({ ok: false, status: 403, error: "forbidden", message });
const bad = (error: string, message: string): ChangeCheck => ({ ok: false, status: 400, error, message });

/**
 * Validates one roster change. `newManager` is the member named by
 * `change.managerId` (null when it is not in the org or not given).
 *
 * Owners and platform admins: set a non-owner's role to rep or manager, and
 * put anyone but an owner under any manager or owner in the org.
 * Managers: claim a rep who has no manager, or release one of their own reps.
 */
export function checkMemberChange(
  actor: ScopeActor,
  target: ScopeMember,
  change: MemberChange,
  newManager: ScopeMember | null,
): ChangeCheck {
  if (!actor.organizationId || actor.organizationId !== target.organizationId) {
    return bad("not_in_org", "That person is not in your organization. Refresh the page and try again.");
  }
  if (target.id === actor.id) return deny("You can't change your own role or manager. Ask an owner.");
  if (target.role === "owner") return deny("Owners can't be moved or changed here.");

  const admin = seesWholeOrg(actor);
  if (change.role !== undefined && !admin) return deny("Only owners can make someone a manager or a rep.");

  if (change.managerId !== undefined) {
    if (change.managerId === null) {
      if (!admin && target.managerId !== actor.id) return deny("You can only release reps on your own team.");
    } else {
      if (change.managerId === target.id) return bad("invalid_manager", "Someone can't be their own manager.");
      if (!newManager || newManager.organizationId !== actor.organizationId) {
        return bad("invalid_manager", "That manager is not in your organization. Refresh the page and pick from the list.");
      }
      const willBeManager = (change.role ?? target.role) === "manager";
      if (newManager.role !== "manager" && newManager.role !== "owner") {
        return bad("invalid_manager", "Pick a manager or an owner to lead this person.");
      }
      if (willBeManager && newManager.role === "manager") {
        return bad("invalid_manager", "Managers report to owners, not to other managers.");
      }
      if (!admin) {
        if (change.managerId !== actor.id) return deny("Managers can only add reps to their own team.");
        if (target.role !== "trainee") return deny("Only reps can join a manager's team.");
        if (target.managerId && target.managerId !== actor.id) return deny("That rep is already on another manager's team. Ask an owner to move them.");
      }
    }
  }
  return { ok: true };
}

/**
 * Whether a whole-team assignment is meant for `member`. Owner assignments
 * (teamOfId null) reach the whole org; a manager's reach their own reps.
 */
export function teamAssignmentReaches(teamOfId: string | null, member: Pick<ScopeMember, "id" | "managerId">): boolean {
  return teamOfId === null || member.managerId === teamOfId || member.id === teamOfId;
}

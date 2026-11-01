/**
 * Organization MFA policy (pure, safe on both sides). The server decides with
 * these helpers; the client only uses the result to show a banner or redirect.
 */

/** `Organization.planTier` value for the Team plan. */
export const TEAM_PLAN = "team";
export const MAX_GRACE_DAYS = 30;

export type MfaState =
  /** The org does not require MFA. */
  | "not_required"
  /** Required, and this user has it. */
  | "compliant"
  /** Required and missing, but the grace period is still running. */
  | "grace"
  /** Required and missing: enrollment only, until they activate. */
  | "enroll_required";

export interface MfaPolicyInput {
  requireMfa: boolean;
  mfaGraceEndsAt: Date | null;
  mfaEnabled: boolean;
}

export function canEnforceMfa(planTier: string | null | undefined): boolean {
  return planTier === TEAM_PLAN;
}

export function mfaStateFor(p: MfaPolicyInput, now: Date = new Date()): MfaState {
  if (!p.requireMfa) return "not_required";
  if (p.mfaEnabled) return "compliant";
  if (p.mfaGraceEndsAt && p.mfaGraceEndsAt.getTime() > now.getTime()) return "grace";
  return "enroll_required";
}

/**
 * Whether an account may switch enforcement on. Turning it off is always allowed.
 * Without this, the person who flips the switch could be locked out of their own team.
 */
export function canRequireMfa(user: { mfaEnabled: boolean }): boolean {
  return user.mfaEnabled;
}

/** End of the grace period, or null for none. Whole days from `now`. */
export function graceEndFor(graceDays: number | null | undefined, now: Date = new Date()): Date | null {
  if (!graceDays || graceDays < 1) return null;
  return new Date(now.getTime() + Math.min(Math.floor(graceDays), MAX_GRACE_DAYS) * 86_400_000);
}

/** Routes and pages a member without MFA can still reach while enforcement is on. */
export const MFA_ENROLLMENT_PATHS = ["/settings/security", "/login", "/register", "/access"];

export function isEnrollmentPath(pathname: string): boolean {
  return MFA_ENROLLMENT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

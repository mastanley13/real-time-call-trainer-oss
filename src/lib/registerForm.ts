/**
 * Sign-up form helpers shared by /register and POST /api/auth/register. Pure and client-safe.
 */

export type RegisterMode = "create" | "join";

/**
 * The org part of the register body: only joinOrgCode in join mode, only newOrgName in create mode, and no
 * newOrgName when the team name is blank (the server then names the workspace after the rep).
 */
export function registerOrgFields(mode: RegisterMode, orgName: string, orgCode: string): { newOrgName?: string; joinOrgCode?: string } {
  if (mode === "join") return { joinOrgCode: orgCode };
  return orgName.trim() ? { newOrgName: orgName } : {};
}

export const REGISTER_FIELDS = ["firstName", "lastName", "email", "phone", "password", "joinOrgCode", "newOrgName"] as const;
export type RegisterField = (typeof REGISTER_FIELDS)[number];

export const BOTH_ORG_FIELDS_MESSAGE = "Choose either a join code or a team name, not both.";
export const UNKNOWN_JOIN_CODE_MESSAGE = "We couldn't find a team with that join code.";
export const REGISTER_FALLBACK_MESSAGE = "Check the form and try again.";

/**
 * True when a raw request body has both a join code and a non-blank team name, matching the schema's rule
 * (a blank team name counts as missing). Read from the raw body because Zod skips the object-level check
 * when another field is missing.
 */
export function hasBothOrgFields(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const { joinOrgCode, newOrgName } = raw as Record<string, unknown>;
  return typeof joinOrgCode === "string" && joinOrgCode !== "" && typeof newOrgName === "string" && newOrgName.trim() !== "";
}

const FIELD_MESSAGES: Record<RegisterField, string> = {
  firstName: "Enter your first name.",
  lastName: "Enter your last name.",
  email: "Enter a valid email address.",
  phone: "Enter a valid phone number.",
  password: "Password must be at least 10 characters.",
  joinOrgCode: "Enter a valid join code.",
  newOrgName: "Team names need at least 2 characters.",
};

/** Over-length values get their own wording, so "Enter your first name." never answers a name that is too long. */
const TOO_LONG_MESSAGES: Partial<Record<RegisterField, string>> = {
  firstName: "First names can be up to 80 characters.",
  lastName: "Last names can be up to 80 characters.",
  password: "Passwords can be up to 200 characters.",
  newOrgName: "Team names can be up to 120 characters.",
};

/** The parts of a Zod issue this needs, so tests can pass plain objects. */
export interface RegisterIssue {
  code: string;
  path: ReadonlyArray<string | number>;
}

export interface RegisterErrorBody {
  error: string;
  fieldErrors: Partial<Record<RegisterField, string>>;
}

const isField = (k: unknown): k is RegisterField => (REGISTER_FIELDS as readonly unknown[]).includes(k);

/**
 * Turns validation issues into one friendly message plus a message per field. Never returns Zod's own text.
 *
 * A join code with a team name (bothOrgFields, or the schema's root-level custom issue) sets the conflict
 * message on joinOrgCode and newOrgName, replacing the team name's own length rule since that field is not used.
 * The top-level error is the first field with a message in REGISTER_FIELDS order (the form's order: names,
 * email, phone, password, then the team fields), so a missing first name is reported before the conflict.
 */
export function registerErrorBody(issues: ReadonlyArray<RegisterIssue>, bothOrgFields = false): RegisterErrorBody {
  const both = bothOrgFields || issues.some((i) => i.code === "custom" && i.path.length === 0);
  const fieldErrors: Partial<Record<RegisterField, string>> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (!isField(field) || fieldErrors[field]) continue;
    fieldErrors[field] = (issue.code === "too_big" && TOO_LONG_MESSAGES[field]) || FIELD_MESSAGES[field];
  }
  if (both) {
    fieldErrors.joinOrgCode = BOTH_ORG_FIELDS_MESSAGE;
    fieldErrors.newOrgName = BOTH_ORG_FIELDS_MESSAGE;
  }
  const first = REGISTER_FIELDS.find((f) => fieldErrors[f]);
  return { error: first ? fieldErrors[first]! : REGISTER_FALLBACK_MESSAGE, fieldErrors };
}

import type { RegisterFormData } from "@/contexts/AuthContext";
import { FREE_VOICE_MIN, type SignupIntent } from "./pricing";

/**
 * Sign-up form logic for /register (pure, client-safe). The limits mirror RegisterSchema in
 * src/app/api/auth/register/route.ts, which stays the source of truth: the client checks first so the rep sees an
 * inline message, and the server checks again. tests/register-form.test.ts keeps the two in step.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const TEAM_NAME_MIN = 2;
export const TEAM_NAME_MAX = 120;
/** Team codes are 3 to 8 digits (orgCodes.ts issues 6; legacy 3-digit codes still work). */
export const TEAM_CODE_PATTERN = /^[0-9]{3,8}$/;

export type WorkspaceMode = "create" | "join";
export type RegisterField = "firstName" | "lastName" | "email" | "password" | "orgName" | "orgCode";
export type RegisterValues = Record<RegisterField, string>;
export type FieldErrors = Partial<Record<RegisterField, string>>;

export const EMPTY_VALUES: RegisterValues = { firstName: "", lastName: "", email: "", password: "", orgName: "", orgCode: "" };

/** DOM ids, so the error summary can link to each field. */
export const FIELD_IDS: Record<RegisterField, string> = {
  firstName: "reg-first-name",
  lastName: "reg-last-name",
  email: "reg-email",
  password: "reg-password",
  orgName: "reg-team-name",
  orgCode: "reg-team-code",
};

/** The fields a mode shows, in DOM order. Only these are validated, sent and listed in the error summary. */
export function visibleFields(mode: WorkspaceMode): RegisterField[] {
  return ["firstName", "lastName", "email", "password", mode === "create" ? "orgName" : "orgCode"];
}

export interface SummaryItem {
  field: RegisterField;
  message: string;
  /** True when the field is on screen, so the summary can link to it. A hidden field's error is shown as text. */
  linked: boolean;
}

/**
 * What the error summary lists: visible fields first, in DOM order, as links; then errors on a field the current mode
 * hides (for example a bad team code after switching to Start a new team), as plain text, so no failure goes unseen.
 */
export function summaryItems(errors: FieldErrors, mode: WorkspaceMode): SummaryItem[] {
  const shown = visibleFields(mode);
  const all: RegisterField[] = ["firstName", "lastName", "email", "password", "orgName", "orgCode"];
  const items: SummaryItem[] = [];
  for (const f of shown) {
    const message = errors[f];
    if (message) items.push({ field: f, message, linked: true });
  }
  for (const f of all) {
    const message = errors[f];
    if (message && !shown.includes(f)) items.push({ field: f, message, linked: false });
  }
  return items;
}

const freeMin: number = FREE_VOICE_MIN;
/** The Free plan line for sign-up, built from the locked plan numbers so it never drifts from pricing. */
export const FREE_SIGNUP_LINE = `Free includes ${freeMin === 10 ? "ten" : freeMin} voice minutes monthly and unlimited text. No card needed.`;
export const PASSWORD_HELP = `At least ${PASSWORD_MIN} characters.`;

/** Deliberately loose: the server's zod check is the real one. This only catches obvious typos before the request. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Checks the visible fields. Returns an empty object when the form can be sent. */
export function validateRegister(values: RegisterValues, mode: WorkspaceMode): FieldErrors {
  const e: FieldErrors = {};
  const first = values.firstName.trim();
  const last = values.lastName.trim();
  const email = values.email.trim();
  if (!first) e.firstName = "Enter your first name.";
  else if (first.length > NAME_MAX) e.firstName = `Use ${NAME_MAX} characters or fewer for your first name.`;
  if (!last) e.lastName = "Enter your last name.";
  else if (last.length > NAME_MAX) e.lastName = `Use ${NAME_MAX} characters or fewer for your last name.`;
  if (!email) e.email = "Enter your email address.";
  else if (email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email)) e.email = "Enter an email address like name@example.com.";
  if (!values.password) e.password = "Enter a password.";
  else if (values.password.length < PASSWORD_MIN) e.password = `Use at least ${PASSWORD_MIN} characters for your password.`;
  else if (values.password.length > PASSWORD_MAX) e.password = `Use ${PASSWORD_MAX} characters or fewer for your password.`;
  if (mode === "create") {
    const team = values.orgName.trim();
    if (!team) e.orgName = "Enter a team name. Practicing alone? Your own name works.";
    else if (team.length < TEAM_NAME_MIN) e.orgName = `Use at least ${TEAM_NAME_MIN} characters for the team name.`;
    else if (team.length > TEAM_NAME_MAX) e.orgName = `Use ${TEAM_NAME_MAX} characters or fewer for the team name.`;
  } else {
    const code = values.orgCode.trim();
    if (!code) e.orgCode = "Enter your team code. Ask your team owner for it.";
    else if (!TEAM_CODE_PATTERN.test(code)) e.orgCode = "Team codes are 3 to 8 digits. Check the code and try again.";
  }
  return e;
}

/**
 * The request body, in the same shape as before this redesign: names, email, password, exactly one of newOrgName or
 * joinOrgCode, and the whitelisted sign-up intent. Email and team code are trimmed; the server trims the rest.
 */
export function buildRegisterPayload(values: RegisterValues, mode: WorkspaceMode, intent: SignupIntent): RegisterFormData {
  return {
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email.trim(),
    password: values.password,
    ...(mode === "create" ? { newOrgName: values.orgName } : { joinOrgCode: values.orgCode.trim() }),
    ...intent,
  };
}

export interface MappedError {
  /** The field the message belongs to, or none for a form-level problem. */
  field?: RegisterField;
  message: string;
  /** Behind the access gate: where to enter the access code. */
  accessLink?: boolean;
}

export const GENERIC_FAILURE = "We could not create your account. Your details are still here. Try again in a moment.";
export const NETWORK_FAILURE = "We could not reach the server. Your details are still here. Check your connection, then try again.";

/**
 * Maps what POST /api/auth/register answered (AuthContext.register throws its `error` string) to a plain message.
 * Matches the route's existing strings and the proxy's access_code_required; it never shows raw validation text.
 */
export function mapServerError(raw: string, mode: WorkspaceMode): MappedError {
  const m = raw.trim();
  if (/already exists/i.test(m)) {
    return { field: "email", message: "An account with this email already exists. Sign in instead, or use another email." };
  }
  if (/unknown organization code/i.test(m)) {
    return mode === "join"
      ? { field: "orgCode", message: "No team uses that code. Check it with your team owner, or start a new team instead." }
      : { message: GENERIC_FAILURE };
  }
  if (/^invite code required$/i.test(m) || m === "access_code_required") {
    return { message: "This trainer is invite-only. Enter the access code you were given, then create your account.", accessLink: true };
  }
  if (/too many registration attempts/i.test(m)) {
    return { message: "Too many sign-up attempts from this network. Wait a minute, then try again." };
  }
  if (/password must be at least/i.test(m)) {
    return { field: "password", message: `Use at least ${PASSWORD_MIN} characters for your password.` };
  }
  if (/either joinOrgCode or newOrgName/i.test(m)) {
    return mode === "create"
      ? { field: "orgName", message: "Enter a team name. Practicing alone? Your own name works." }
      : { field: "orgCode", message: "Enter your team code. Ask your team owner for it." };
  }
  if (/invalid email/i.test(m)) {
    return { field: "email", message: "Enter an email address like name@example.com." };
  }
  // fetch() rejects with a TypeError whose text depends on the browser.
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
    return { message: NETWORK_FAILURE };
  }
  return { message: GENERIC_FAILURE };
}

/** The access page link that brings the rep back to this sign-up (same-origin paths only, checked there too). */
export function accessHref(returnTo: string): string {
  const next = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/register";
  return `/access?next=${encodeURIComponent(next)}`;
}

export type SubmitOutcome =
  | { kind: "ignored" }
  | { kind: "invalid"; errors: FieldErrors }
  | { kind: "ok" }
  | { kind: "failed"; error: MappedError };

/**
 * One submit handler per form. Validation runs first and never shows the pending state; pending turns on only when
 * the request starts. A second submit while one is in flight, or after one succeeded (the page is redirecting), is
 * ignored. A failure turns pending off and leaves the caller's values alone, so the rep can fix and retry.
 */
export function createSubmitter(register: (payload: RegisterFormData) => Promise<void>, setPending: (pending: boolean) => void) {
  let inFlight = false;
  let done = false;
  return async function submit(values: RegisterValues, mode: WorkspaceMode, intent: SignupIntent): Promise<SubmitOutcome> {
    if (inFlight || done) return { kind: "ignored" };
    const errors = validateRegister(values, mode);
    if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
    inFlight = true;
    setPending(true);
    try {
      await register(buildRegisterPayload(values, mode, intent));
      done = true;
      return { kind: "ok" };
    } catch (err) {
      setPending(false);
      return { kind: "failed", error: mapServerError(err instanceof Error ? err.message : "", mode) };
    } finally {
      inFlight = false;
    }
  };
}

// ---- Draft, so values survive leaving the page (Terms, Sign in) and coming back -----------------------------------

export const DRAFT_KEY = "ct.registerDraft";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface RegisterDraft { mode: WorkspaceMode; values: Omit<RegisterValues, "password"> }

/** Saves the draft for this tab. The password is never stored. Blocked storage is ignored. */
export function saveDraft(mode: WorkspaceMode, values: RegisterValues, store?: Store | null): void {
  const { password: _never, ...rest } = values;
  void _never;
  try {
    (store ?? sessionStorage).setItem(DRAFT_KEY, JSON.stringify({ mode, values: rest }));
  } catch {
    // Private mode or blocked storage: the draft is a courtesy.
  }
}

/** Reads the draft back, keeping only known string fields within their limits. Never returns a password. */
export function loadDraft(store?: Store | null): RegisterDraft | null {
  try {
    const raw = (store ?? sessionStorage).getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { mode?: unknown; values?: Record<string, unknown> };
    if (!d || typeof d !== "object" || !d.values || typeof d.values !== "object") return null;
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    return {
      mode: d.mode === "join" ? "join" : "create",
      values: {
        firstName: s(d.values.firstName, NAME_MAX),
        lastName: s(d.values.lastName, NAME_MAX),
        email: s(d.values.email, EMAIL_MAX),
        orgName: s(d.values.orgName, TEAM_NAME_MAX),
        orgCode: s(d.values.orgCode, 8),
      },
    };
  } catch {
    return null;
  }
}

export function clearDraft(store?: Store | null): void {
  try {
    (store ?? sessionStorage).removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

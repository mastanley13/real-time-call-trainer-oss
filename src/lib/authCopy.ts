/** Shared MFA and sign-in error copy. Safe on the client. */

export const CODE_USED_ERROR = "code_used";
export const CODE_USED_MESSAGE =
  "That code was just used. Wait for the next code in your app, then enter it.";

export const CHALLENGE_EXPIRED = "Expired or invalid challenge. Sign in again.";

/** Prefer the human `message` when the API sent one; otherwise the `error` string. */
export function apiErrorText(
  body: { message?: unknown; error?: unknown } | null | undefined,
  fallback: string,
): string {
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  if (typeof body?.error === "string" && body.error.trim()) return body.error;
  return fallback;
}

/** True when the MFA step should be abandoned and the email/password form shown again. */
export function shouldRestartLogin(message: string): boolean {
  return message.includes("Sign in again");
}

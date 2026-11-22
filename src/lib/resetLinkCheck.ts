/**
 * Client-safe decisions for the reset page's load-time link check. The component only wires these together, so the
 * behavior is unit-tested without a DOM. The server still verifies the link on submit, so any doubt shows the form.
 */

export const RESET_CHECK_PATH = "/api/auth/password-reset/check";

export type CheckOutcome = "valid" | "invalid" | "unknown";
export type ResetView = "no-token" | "checking" | "invalid" | "form";

/** Only a 200 with { valid: false } is invalid and only a 200 with { valid: true } is valid. Anything else is unknown. */
export function checkOutcome(status: number, body: unknown): CheckOutcome {
  if (status !== 200 || typeof body !== "object" || body === null) return "unknown";
  const valid = (body as { valid?: unknown }).valid;
  if (valid === true) return "valid";
  if (valid === false) return "invalid";
  return "unknown";
}

/** What one form instance (one token) shows. Null means the check has not answered yet. */
export function resetView(token: string, outcome: CheckOutcome | null): ResetView {
  if (!token) return "no-token";
  if (outcome === null) return "checking";
  return outcome === "invalid" ? "invalid" : "form";
}

/** Invalid is sticky: a link can only die, never revive, so a check answer never replaces an invalid outcome. */
export function applyCheckResult(prev: CheckOutcome | null, result: CheckOutcome): CheckOutcome {
  return prev === "invalid" ? prev : result;
}

/** POSTs { token } to the check route (never in the URL). Network errors and unreadable replies are unknown. */
export async function fetchResetCheck(token: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<CheckOutcome> {
  try {
    const res = await fetchImpl(RESET_CHECK_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal,
    });
    const body: unknown = await res.json().catch(() => undefined);
    return checkOutcome(res.status, body);
  } catch {
    return "unknown";
  }
}

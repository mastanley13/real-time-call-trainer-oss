/**
 * MFA recovery codes: the parts both the settings page and the server need. Pure and client-safe; generation,
 * hashing and consumption live in mfaRecovery.ts (server-only).
 */

/** Codes issued per account, on activation and on every regeneration. */
export const RECOVERY_CODE_COUNT = 10;

/** At or below this many unused codes the settings page shows a warning. */
export const RECOVERY_CODES_LOW = 3;

/** "7 of 10 recovery codes left", with singular and empty forms. */
export function recoveryCodesLabel(remaining: number, total = RECOVERY_CODE_COUNT): string {
  if (remaining <= 0) return "No recovery codes left";
  return `${remaining} of ${total} recovery ${remaining === 1 ? "code" : "codes"} left`;
}

/** True when the count should be shown with a warning: three or fewer left, or none at all. */
export function recoveryCodesLow(remaining: number): boolean {
  return remaining <= RECOVERY_CODES_LOW;
}

/** Contents of the downloadable .txt file. Plain text, one code per line, no account secrets beyond the codes. */
export function recoveryCodesFile(codes: readonly string[], opts: { account?: string; issuedAt?: Date } = {}): string {
  const issued = (opts.issuedAt ?? new Date()).toISOString().slice(0, 10);
  return [
    "Real-Time Call Trainer recovery codes",
    ...(opts.account ? [`Account: ${opts.account}`] : []),
    `Issued: ${issued}`,
    "",
    "Each code works once. Use one to sign in when you cannot reach your authenticator app.",
    "Store this file somewhere safe, like a password manager. Regenerating codes makes these stop working.",
    "",
    ...codes,
    "",
  ].join("\n");
}

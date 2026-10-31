export type RegisterMode = "solo" | "create" | "join";

/**
 * What the "Sign up with Google" button sends for the current form state.
 * Join uses the code the person entered, not the one from an invite link. The
 * invite's manager only applies while the entered code still matches it.
 * Returns null in join mode with no code: that must never fall back to solo, so
 * the button stays disabled until a code is entered.
 */
export function googleSignupParams(
  mode: RegisterMode,
  orgCode: string,
  invite: { code: string; manager?: string } | null,
): { intent: "solo" | "team"; code?: string; manager?: string } | null {
  if (mode === "create") return { intent: "team" };
  if (mode !== "join") return { intent: "solo" };
  const code = orgCode.trim();
  if (!code) return null;
  const manager = invite?.manager && invite.code === code ? invite.manager : undefined;
  return { intent: "solo", code, ...(manager ? { manager } : {}) };
}

export type RegisterMode = "solo" | "create" | "join";

/**
 * What the "Sign up with Google" button sends for the current form state.
 * Join uses the code the person entered, not the one from an invite link. The
 * invite's manager only applies while the entered code still matches it.
 */
export function googleSignupParams(
  mode: RegisterMode,
  orgCode: string,
  invite: { code: string; manager?: string } | null,
): { intent: "solo" | "team"; code?: string; manager?: string } {
  if (mode === "create") return { intent: "team" };
  if (mode !== "join") return { intent: "solo" };
  const code = orgCode.trim();
  if (!code) return { intent: "solo" };
  const manager = invite?.manager && invite.code === code ? invite.manager : undefined;
  return { intent: "solo", code, ...(manager ? { manager } : {}) };
}

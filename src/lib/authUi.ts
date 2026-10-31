/** Pure auth UI rules, shared by the sign-in, sign-up and debrief pages (client-safe). */
import type { Capabilities } from "@/contexts/AuthContext";

export const LOGIN_PATH = "/login";

export const ACCOUNTS_UNAVAILABLE_COPY = {
  register: "Sign-up isn't available right now. Try the demo instead.",
  login: "Sign-in isn't available right now. Try the demo instead.",
} as const;

/** True once the server has said it has no database and is not in demo mode, so no account can be made or used. */
export function accountsUnavailable(caps: Pick<Capabilities, "database" | "demoMode"> | null): boolean {
  return Boolean(caps && !caps.database && !caps.demoMode);
}

/** Whether a private page may show stored data. Browser-stored sessions need a signed-in user too, except in demo mode. */
export function canViewPrivate(state: { isAuthenticated: boolean; demoMode: boolean }): boolean {
  return state.isAuthenticated || state.demoMode;
}

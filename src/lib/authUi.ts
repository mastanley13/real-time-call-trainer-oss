/** Pure auth UI rules, shared by the sign-in, sign-up, debrief pages and sign-out (client-safe). */
import type { Capabilities } from "@/contexts/AuthContext";

export const LOGIN_PATH = "/login";

export const ACCOUNTS_COPY = {
  loading: "Checking sign-in options…",
  error: "We couldn't check whether sign-in is available. Check your connection, then try again.",
  retry: "Try again",
  unavailable: {
    register: "Sign-up isn't available on this server. Ask whoever runs it to set up accounts or turn on demo mode.",
    login: "Sign-in isn't available on this server. Ask whoever runs it to set up accounts or turn on demo mode.",
  },
} as const;

export type AccountsState = "loading" | "error" | "unavailable" | "ready";
type Caps = Pick<Capabilities, "database" | "demoMode"> | null;

/**
 * Whether accounts can be used. Unknown (config not loaded yet, or the config call failed) blocks submission,
 * so nothing can be sent before the server has said it has a database.
 */
export function accountsState(caps: Caps, configError = false): AccountsState {
  if (configError) return "error";
  if (!caps) return "loading";
  return !caps.database && !caps.demoMode ? "unavailable" : "ready";
}

/** The only state in which the sign-in and sign-up forms may be submitted. */
export function canSubmitAccounts(caps: Caps, configError = false): boolean {
  return accountsState(caps, configError) === "ready";
}

/** Copy shown instead of the form while the stored session is unknown or already signed in. */
export const SESSION_COPY = { checking: "Checking your session…", redirecting: "You're signed in. Taking you to the trainer…" } as const;

/**
 * Whether the sign-in and sign-up form may be shown. Hidden while the stored session is still being read and once
 * signed in (the page is about to redirect). A submit in flight keeps it visible so typed values and the MFA step stay put.
 */
export function accountFormVisible(s: { isLoading: boolean; isAuthenticated: boolean; busy?: boolean }): boolean {
  if (s.isAuthenticated) return false;
  return !s.isLoading || !!s.busy;
}

/** Load /api/config. Any failure (network, non-OK, bad body) is reported as an error, never as a guess about the server. */
export async function loadConfig(fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): Promise<{ caps: Capabilities } | { error: true }> {
  try {
    const res = await fetchImpl("/api/config");
    if (!res.ok) return { error: true };
    const body = (await res.json()) as Capabilities | null;
    return body && typeof body === "object" && typeof body.database === "boolean" ? { caps: body } : { error: true };
  } catch {
    return { error: true };
  }
}

/** Form submit gate: always stops the browser submit, and runs `run` only when accounts are ready. Returns whether it ran. */
export function guardedSubmit(e: { preventDefault: () => void }, caps: Caps, run: () => void, configError = false): boolean {
  e.preventDefault();
  if (!canSubmitAccounts(caps, configError)) return false;
  run();
  return true;
}

/** Whether a private page may show stored data. Browser-stored sessions need a signed-in user too, except in demo mode. */
export function canViewPrivate(state: { isAuthenticated: boolean; demoMode: boolean }): boolean {
  return state.isAuthenticated || state.demoMode;
}

/** Sign-out: clear client state first, tell the server, then replace the current route with /login so Back cannot return to it. */
export function performLogout(deps: { clearSession: () => void; notifyServer: () => Promise<unknown>; replace: (path: string) => void }) {
  deps.clearSession();
  deps.notifyServer().catch(() => {});
  deps.replace(LOGIN_PATH);
}

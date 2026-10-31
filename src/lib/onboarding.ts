/** First-run "Getting started" panel: storage helpers and welcome copy. Pure and client-safe; storage is passed in so tests need no browser. */

export const ONBOARDING_KEY = "ct.onboarding.v1";
export const WELCOME_KEY = "ct.welcome.v1";

export type WelcomeMode = "create" | "join";
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const ONBOARDING_STEPS = [
  { title: "Pick a scenario", help: "Choose a persona that matches the call you want to practise." },
  { title: "Have the call", help: "Talk or type your side. The caller stays in character." },
  { title: "Read your debrief", help: "See what landed, with quotes from your own call." },
] as const;

export const BASELINE_LINE = "Your first grade is a baseline.";

/** "unavailable" means storage threw, so the caller hides the panel for this page session only. */
export function readOnboarding(store: KeyValueStore | null): "dismissed" | "open" | "unavailable" {
  if (!store) return "unavailable";
  try {
    return store.getItem(ONBOARDING_KEY) === "dismissed" ? "dismissed" : "open";
  } catch {
    return "unavailable";
  }
}

/** Returns false when storage refused the write; the caller still hides the panel. */
export function markOnboardingSeen(store: KeyValueStore | null): boolean {
  if (!store) return false;
  try {
    store.setItem(ONBOARDING_KEY, "dismissed");
    return true;
  } catch {
    return false;
  }
}

export function setWelcome(store: KeyValueStore | null, mode: WelcomeMode): void {
  try { store?.setItem(WELCOME_KEY, mode); } catch { /* storage unavailable */ }
}

/** Reads the one-time welcome flag from registration and clears it. */
export function takeWelcome(store: KeyValueStore | null): WelcomeMode | null {
  if (!store) return null;
  try {
    const v = store.getItem(WELCOME_KEY);
    store.removeItem(WELCOME_KEY);
    return v === "create" || v === "join" ? v : null;
  } catch {
    return null;
  }
}

/** The welcome line. The team sentence only appears right after signup and only when the user has a team. */
export function welcomeCopy(firstName: string | undefined, orgName: string | undefined, mode: WelcomeMode | null): string {
  const name = firstName?.trim();
  const team = orgName?.trim();
  const hello = name ? `Welcome, ${name}.` : "Welcome.";
  if (!team || !mode) return hello;
  return mode === "create" ? `${hello} Your team ${team} is ready.` : `${hello} You joined ${team}.`;
}

/** Safe handle on a Web Storage area; null when the browser blocks access outright. */
export function safeStorage(kind: "local" | "session"): KeyValueStore | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

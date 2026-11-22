/**
 * Post-login redirect targets. Pure and client-safe: the Google routes and the /auth/complete page both use it.
 * Only same-site paths pass: no control characters (the URL parser drops tabs and newlines, so "/<TAB>/host"
 * would become "//host"), no backslashes, and the parsed result must stay on the same origin.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/trainer"): string {
  if (!raw || raw.length > 200) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const base = "http://same-site.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

/** The next path when it passes safeNextPath, else null, so a caller can keep its own default destination. */
export function validNextPath(raw: string | null | undefined): string | null {
  return safeNextPath(raw, "") || null;
}

/** The sign-in link: /login?next=<encoded path> for a safe next, else plain /login. */
export function signInHref(next: string | null | undefined): string {
  const path = validNextPath(next);
  return path ? `/login?next=${encodeURIComponent(path)}` : "/login";
}

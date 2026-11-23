/**
 * True when a parsed pathname is "/api" or under "/api/". The first segment is percent-decoded (a malformed
 * escape keeps it raw) and lowercased, so "/API/x" and "/%61pi/x" count; a decoded "/" inside it is treated as
 * a separator, so "/%2Fapi" and "/api%2Fx" count too. Look-alikes such as "/apix" and "/api-docs" do not.
 */
function isApiPathname(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  let decoded = first;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // Malformed escape: compare the raw segment.
  }
  const head = decoded.toLowerCase().split("/").find((s) => s !== "");
  return head === "api";
}

/**
 * Post-login redirect targets. Pure and client-safe: the Google routes and the /auth/complete page both use it.
 * Only same-site page paths pass: no control characters (the URL parser drops tabs and newlines, so "/<TAB>/host"
 * would become "//host"), no backslashes, the parsed result must stay on the same origin, and its normalized
 * pathname must not be an API route ("/api" or anything under "/api/", in any case or percent-encoding, after
 * dot segments resolve, so "/foo/../api/x" and "/api?x=1" fail). The query and fragment are not inspected, so
 * "/trainer?from=/api/x" passes.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/trainer"): string {
  if (!raw || raw.length > 200) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const base = "http://same-site.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return fallback;
    if (isApiPathname(url.pathname)) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

/** The next path when it passes safeNextPath, else null, so a caller can keep its own default destination. */
export function validNextPath(raw: string | null | undefined): string | null {
  return safeNextPath(raw, "") || null;
}

/** Where /login sends a signed-in user: a safe ?next= path, else /trainer. */
export function loginDestination(rawNext: string | null | undefined): string {
  return safeNextPath(rawNext, "/trainer");
}

/** The sign-in link: /login?next=<encoded path> for a safe next, else plain /login. */
export function signInHref(next: string | null | undefined): string {
  const path = validNextPath(next);
  return path ? `/login?next=${encodeURIComponent(path)}` : "/login";
}

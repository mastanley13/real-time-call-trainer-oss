/**
 * Browser-only freshness hint. This never authorizes a request: the server still
 * verifies the signed session cookie. Recheck it when starting a call because a
 * trainer tab can remain open longer than the session's twelve-hour lifetime.
 */
export function isTokenFresh(token: string | null, now = Date.now()): boolean {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload: unknown = JSON.parse(atob(b64 + pad));
    if (!payload || typeof payload !== "object" || !("exp" in payload)) return false;
    return typeof payload.exp === "number" && payload.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

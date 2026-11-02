/**
 * First-touch attribution: the UTM tags and referrer host of the first tagged visit, kept in the
 * first-party `ct_ft` cookie for 30 days and sent with sign-up. Pure and safe on edge, node and client.
 *
 * First touch wins: once `ct_ft` exists it is never rewritten. A visit with no UTM tags and no outside
 * referrer stores nothing, so a later tagged visit can still become the first touch.
 */

export const FT_COOKIE = "ct_ft";
export const FT_MAX_AGE = 30 * 24 * 60 * 60;
export const FT_MAX_LEN = 120;

/** URL parameter, and the camelCase name used in the register body, user record and GHL payload. */
export const UTM_PARAMS = [
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["utm_content", "utmContent"],
  ["utm_term", "utmTerm"],
] as const;

export type FirstTouch = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  /** Referrer host only: no scheme, port, path or query. */
  referrer?: string;
};
export type TouchKey = keyof FirstTouch;
export const TOUCH_KEYS: readonly TouchKey[] = [...UTM_PARAMS.map(([, k]) => k), "referrer"];

/** Our own hosts never count as a referrer. */
const OWN_DOMAIN = "calltrainer.tech";

/** Lowercase, keep only [a-z0-9-_.], at most 120 characters. Anything that leaves nothing is dropped. */
export function sanitizeTouchValue(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const clean = v.slice(0, 2048).toLowerCase().replace(/[^a-z0-9\-_.]/g, "").slice(0, FT_MAX_LEN);
  return clean || undefined;
}

const isOwnHost = (host: string, selfHost?: string) => host === OWN_DOMAIN || host.endsWith(`.${OWN_DOMAIN}`) || (!!selfHost && host === selfHost.toLowerCase());

/** The host of a Referer value, or undefined for our own site, a bad URL or a non-web scheme. */
export function referrerHost(referer: string | null | undefined, selfHost?: string): string | undefined {
  if (!referer) return undefined;
  try {
    const u = new URL(referer);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    const host = u.hostname.toLowerCase();
    return isOwnHost(host, selfHost) ? undefined : sanitizeTouchValue(host);
  } catch {
    return undefined;
  }
}

/** Sanitizes every field of an untrusted object (a request body or a parsed cookie). */
export function sanitizeTouch(input: Partial<Record<TouchKey, unknown>> | null | undefined): FirstTouch {
  const out: FirstTouch = {};
  if (!input) return out;
  for (const k of TOUCH_KEYS) {
    const raw = input[k];
    // A full URL sent as the referrer is reduced to its host rather than mangled into one string.
    const v = k === "referrer" && typeof raw === "string" && raw.includes("://") ? referrerHost(raw) : sanitizeTouchValue(raw);
    if (v && !(k === "referrer" && isOwnHost(v))) out[k] = v;
  }
  return out;
}

export const hasTouch = (t: FirstTouch) => TOUCH_KEYS.some((k) => !!t[k]);

/** UTM tags from a query string. */
export function touchFromSearch(search: URLSearchParams | string): FirstTouch {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw: Partial<Record<TouchKey, unknown>> = {};
  for (const [param, key] of UTM_PARAMS) raw[key] = q.get(param);
  return sanitizeTouch(raw);
}

/** Cookie value: a query string of the sanitized URL parameter names (utm_source=...&referrer=...). */
export function encodeTouchCookie(t: FirstTouch): string {
  const q = new URLSearchParams();
  for (const [param, key] of UTM_PARAMS) if (t[key]) q.set(param, t[key]!);
  if (t.referrer) q.set("referrer", t.referrer);
  return q.toString();
}

/** Parses a `ct_ft` value. Values are sanitized again, because a cookie is user-controlled. */
export function parseTouchCookie(value: string | null | undefined): FirstTouch {
  if (!value) return {};
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(value.includes("%") ? decodeURIComponent(value) : value);
  } catch {
    return {};
  }
  return { ...touchFromSearch(q), ...sanitizeTouch({ referrer: q.get("referrer") }) };
}

/** Reads one cookie from a `document.cookie` or Cookie header string. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The first touch when there is one, else the fallback. Whole, never mixed, so one visit's tags stay together. */
export const preferTouch = (first: FirstTouch, fallback: FirstTouch): FirstTouch => (hasTouch(first) ? first : fallback);

/** What /register sends: the ct_ft cookie when it holds anything, else the tags on the current URL. */
export function touchForRegister(cookieHeader: string | null | undefined, search: string): FirstTouch {
  return preferTouch(parseTouchCookie(readCookie(cookieHeader, FT_COOKIE)), touchFromSearch(search));
}

/**
 * GHL inbound_source: "<utm_source>/<utm_campaign>", or utm_source alone when there is no campaign,
 * else the referrer host, else "direct". A campaign without a source is not enough to name a source.
 */
export function inboundSource(t: FirstTouch): string {
  if (t.utmSource) return t.utmCampaign ? `${t.utmSource}/${t.utmCampaign}` : t.utmSource;
  return t.referrer || "direct";
}

/** utm_medium values that mark a contact we reached out to first. */
export const OUTBOUND_MEDIUMS: ReadonlySet<string> = new Set(["dm", "outbound"]);

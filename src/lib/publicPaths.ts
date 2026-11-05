/** Paths that bypass the optional TRAINER_ACCESS_CODE gate. Edge-safe: no Node imports. */
import { tenant, verticalsAllowed } from "./tenant";
import type { PublicPathKey, TenantConfig } from "./tenant-schema";

export const VERTICAL_SLUGS = ["insurance", "solar", "staffing", "home-services", "saas-sdr", "coaches"] as const;

/** Root share images, with or without the content hash Next appends. */
const ROOT_IMAGE = /^\/(opengraph|twitter)-image(-[A-Za-z0-9]+)?$/;
/** Per-vertical share images, with or without the content hash Next appends. */
const VERTICAL_IMAGE = new RegExp(`^/for/(${VERTICAL_SLUGS.join("|")})/(opengraph|twitter)-image(-[A-Za-z0-9]+)?$`);
const VERTICAL_PAGES = new Set(VERTICAL_SLUGS.map((s) => `/for/${s}`));

/**
 * How each allowlist entry (access.publicPaths) matches. `p` is normalized (no trailing slash); `raw` is the path as
 * sent. The landing and legal pages match `raw` exactly, as the middleware always did, so /privacy/ stays gated.
 */
const MATCHERS: Record<PublicPathKey, (p: string, raw: string) => boolean> = {
  "/": (_p, raw) => raw === "/",
  "/privacy": (_p, raw) => raw === "/privacy",
  "/terms": (_p, raw) => raw === "/terms",
  "/pricing": (p) => p === "/pricing",
  "/register": (p) => p === "/register",
  "/login": (p) => p === "/login",
  "/auth/complete": (p) => p === "/auth/complete",
  "/robots.txt": (p) => p === "/robots.txt",
  "/sitemap.xml": (p) => p === "/sitemap.xml",
  "/for/*": (p) => VERTICAL_PAGES.has(p),
  "/opengraph-image": (p) => ROOT_IMAGE.test(p) || VERTICAL_IMAGE.test(p),
  "/api/auth/*": (p) => p.startsWith("/api/auth/"),
};

/**
 * The entries this tenant keeps public: access.publicPaths, minus "/" when features.publicLanding is off and minus
 * /for/* unless the vertical pages are served (publicLanding and pricing). A tenant can only narrow the OSS list; the schema rejects anything that is not one of its entries.
 */
export function publicPathKeys(config: TenantConfig = tenant): PublicPathKey[] {
  const landing = config.features.publicLanding !== false;
  const verticals = verticalsAllowed(config);
  return config.access.publicPaths.filter((k) => (k === "/" ? landing : k === "/for/*" ? verticals : true));
}

const DEFAULT_KEYS = publicPathKeys();

/** True when the path is public even with the access code set. A query string, hash fragment or trailing slash is ignored. */
export function isPublicPath(pathname: string, keys: readonly PublicPathKey[] = DEFAULT_KEYS): boolean {
  const bare = pathname.split(/[?#]/, 1)[0];
  const p = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  // Vertical share images follow their pages: public only while /for/* is.
  if (VERTICAL_IMAGE.test(p) && !keys.includes("/for/*")) return false;
  return keys.some((k) => MATCHERS[k](p, bare));
}

/** The gate's own endpoints and machine callers, always reachable: /access, /api/access, /api/health, cron, the Stripe webhook. */
export function isGateExempt(pathname: string): boolean {
  return pathname === "/access" || pathname === "/api/access" || pathname === "/api/health" || pathname === "/api/stripe/webhook" || pathname.startsWith("/api/cron/");
}

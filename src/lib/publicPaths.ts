/** Paths that bypass the optional TRAINER_ACCESS_CODE gate. Edge-safe: no Node imports. */

export const VERTICAL_SLUGS = ["insurance", "solar", "staffing", "home-services", "saas-sdr", "coaches"] as const;

const EXACT = new Set([
  "/pricing", "/privacy", "/terms", "/register", "/login", "/robots.txt", "/sitemap.xml",
  ...VERTICAL_SLUGS.map((s) => `/for/${s}`),
]);
const PREFIXES = ["/api/auth/", "/opengraph-image", "/twitter-image"];
/** Per-vertical share images, with or without the content hash Next appends. */
const VERTICAL_IMAGE = new RegExp(`^/for/(${VERTICAL_SLUGS.join("|")})/(opengraph|twitter)-image(-[A-Za-z0-9]+)?$`);

/** True when the path is public even with the access code set. A trailing slash is ignored. */
export function isPublicPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return EXACT.has(p) || PREFIXES.some((x) => p.startsWith(x)) || VERTICAL_IMAGE.test(p);
}

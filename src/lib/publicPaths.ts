/** Paths that bypass the optional TRAINER_ACCESS_CODE gate. Edge-safe: no Node imports. */

export const VERTICAL_SLUGS = ["insurance", "solar", "staffing", "home-services", "saas-sdr", "coaches"] as const;

const EXACT = new Set([
  "/pricing", "/register", "/login", "/robots.txt", "/sitemap.xml",
  ...VERTICAL_SLUGS.map((s) => `/for/${s}`),
]);
const PREFIXES = ["/api/auth/"];
/** Root share images, with or without the content hash Next appends. */
const ROOT_IMAGE = /^\/(opengraph|twitter)-image(-[A-Za-z0-9]+)?$/;
/** Per-vertical share images, with or without the content hash Next appends. */
const VERTICAL_IMAGE = new RegExp(`^/for/(${VERTICAL_SLUGS.join("|")})/(opengraph|twitter)-image(-[A-Za-z0-9]+)?$`);

/** True when the path is public even with the access code set. A query string, hash fragment or trailing slash is ignored. */
export function isPublicPath(pathname: string): boolean {
  const bare = pathname.split(/[?#]/, 1)[0];
  const p = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return EXACT.has(p) || PREFIXES.some((x) => p.startsWith(x)) || ROOT_IMAGE.test(p) || VERTICAL_IMAGE.test(p);
}

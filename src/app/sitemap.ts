import type { MetadataRoute } from "next";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { siteUrl } from "@/lib/seo";
import { TRY_ROLE_SLUGS } from "@/lib/tryRoles";

const PATHS = ["", "/pricing", "/library", "/compete", "/privacy", "/terms", ...VERTICAL_SLUGS.map((s) => `/for/${s}`), ...TRY_ROLE_SLUGS.map((s) => `/try/${s}`)];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${siteUrl()}${p}` }));
}

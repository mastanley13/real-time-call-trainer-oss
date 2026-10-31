import type { MetadataRoute } from "next";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { SITE_URL } from "@/lib/seo";

const PATHS = ["", "/pricing", "/privacy", "/terms", ...VERTICAL_SLUGS.map((s) => `/for/${s}`)];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${SITE_URL}${p}` }));
}

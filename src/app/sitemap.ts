import type { MetadataRoute } from "next";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { siteUrl } from "@/lib/seo";

const PATHS = ["", "/pricing", "/privacy", "/terms", ...VERTICAL_SLUGS.map((s) => `/for/${s}`)];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${siteUrl()}${p}` }));
}

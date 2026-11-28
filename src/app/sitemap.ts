import type { MetadataRoute } from "next";
import { ALTERNATIVE_SLUGS, COMPARISON_SLUGS, ROLEPLAY_HUB_PATH, USE_CASE_SLUGS, VERTICAL_SLUGS } from "@/lib/publicPaths";
import { siteUrl } from "@/lib/seo";
import { TRY_ROLE_SLUGS } from "@/lib/tryRoles";

const PATHS = [
  "", "/pricing", "/library", "/compete", "/alternatives", ROLEPLAY_HUB_PATH, "/privacy", "/terms",
  ...VERTICAL_SLUGS.map((s) => `/for/${s}`),
  ...TRY_ROLE_SLUGS.map((s) => `/try/${s}`),
  ...COMPARISON_SLUGS.map((s) => `/vs/${s}`),
  ...ALTERNATIVE_SLUGS.map((s) => `/alternatives/${s}`),
  ...USE_CASE_SLUGS.map((s) => `/use-cases/${s}`),
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${siteUrl()}${p}` }));
}

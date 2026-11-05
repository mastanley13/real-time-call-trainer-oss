import type { MetadataRoute } from "next";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { siteUrl } from "@/lib/seo";
import { featureAllowed, verticalsAllowed } from "@/lib/tenant";

const landing = featureAllowed("publicLanding");
const PATHS = [
  ...(landing ? [""] : []),
  ...(featureAllowed("pricing") ? ["/pricing"] : []),
  "/privacy",
  "/terms",
  ...(verticalsAllowed() ? VERTICAL_SLUGS.map((s) => `/for/${s}`) : []),
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map((p) => ({ url: `${siteUrl()}${p}` }));
}

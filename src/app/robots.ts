import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/dashboard", "/settings", "/team", "/trainer"] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

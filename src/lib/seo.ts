import type { Metadata } from "next";

export const SITE_URL = "https://calltrainer.tech";
export const GITHUB_URL = "https://github.com/mastanley13/real-time-call-trainer-oss";
export const OG_ALT = "Real-Time Call Trainer: Practice the call before it costs you the deal";

/** Title, description, canonical, Open Graph and Twitter card for a public page. The title is used as written. */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  const url = `${SITE_URL}${path === "/" ? "" : path}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, siteName: "Real-Time Call Trainer", title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

import type { Metadata } from "next";

export const DEFAULT_SITE_URL = "https://calltrainer.tech";

/** Canonical origin for metadata, share images and the sitemap. Reads APP_URL only, never VERCEL_URL or the preview host. */
export function siteUrl(): string {
  const raw = process.env.APP_URL?.trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      /* fall through to the default */
    }
  }
  return DEFAULT_SITE_URL;
}
export const GITHUB_URL = "https://github.com/mastanley13/real-time-call-trainer-oss";
export const OG_ALT = "Real-Time Call Trainer: Practice the call before it costs you the deal";

type ShareImage = { url: string; width: number; height: number; alt: string };

/** Absolute share image URLs on the canonical origin. Next.js prefers VERCEL_URL for file-based images on previews, so metadata names them explicitly. */
export function shareImages(path: string): { openGraph: ShareImage[]; twitter: ShareImage[] } {
  const base = path === "/" ? "" : path;
  const img = (name: string): ShareImage => ({ url: `${siteUrl()}${base}/${name}`, width: 1200, height: 630, alt: OG_ALT });
  return { openGraph: [img("opengraph-image")], twitter: [img("twitter-image")] };
}

/** Title, description, canonical, Open Graph and Twitter card for a public page. The title is used as written. */
export function pageMetadata({ title, description, path, imagePath }: { title: string; description: string; path: string; imagePath?: string }): Metadata {
  const images = shareImages(imagePath ?? "/");
  const url = `${siteUrl()}${path === "/" ? "" : path}`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, siteName: "Real-Time Call Trainer", title, description, images: images.openGraph },
    twitter: { card: "summary_large_image", title, description, images: images.twitter },
  };
}

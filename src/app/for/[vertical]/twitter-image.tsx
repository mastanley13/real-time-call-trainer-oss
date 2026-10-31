import { notFound } from "next/navigation";
import { LANDINGS, type VerticalSlug } from "@/lib/landing";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { renderShareCard } from "@/lib/shareCard";

export const alt = "Real-Time Call Trainer";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamicParams = false;

export function generateStaticParams() {
  return VERTICAL_SLUGS.map((vertical) => ({ vertical }));
}

/** Same card as opengraph-image.tsx. */
export default async function Image({ params }: { params: Promise<{ vertical: string }> }) {
  const { vertical } = await params;
  const l = LANDINGS[vertical as VerticalSlug];
  if (!l) notFound();
  return renderShareCard(l.hero);
}

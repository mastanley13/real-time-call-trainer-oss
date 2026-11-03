import { notFound } from "next/navigation";
import LandingPage from "@/components/landing/LandingPage";
import { LANDINGS, type VerticalSlug } from "@/lib/landing";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return VERTICAL_SLUGS.map((vertical) => ({ vertical }));
}

type Props = { params: Promise<{ vertical: string }> };

export async function generateMetadata({ params }: Props) {
  const { vertical } = await params;
  const l = LANDINGS[vertical as VerticalSlug];
  if (!l) return {};
  return pageMetadata({ title: l.title, description: l.description, path: `/for/${l.slug}`, imagePath: `/for/${l.slug}` });
}

export default async function VerticalPage({ params }: Props) {
  const { vertical } = await params;
  const l = LANDINGS[vertical as VerticalSlug];
  if (!l) notFound();
  return <LandingPage l={l} />;
}

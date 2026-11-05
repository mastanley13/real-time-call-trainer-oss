import { notFound } from "next/navigation";
import LandingPage from "@/components/landing/LandingPage";
import { LANDINGS, type VerticalSlug } from "@/lib/landing";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { pageMetadata } from "@/lib/seo";
import { billingOn } from "@/lib/serverConfig";
import { verticalsAllowed } from "@/lib/tenant";

export const dynamicParams = false;
// The plan buttons depend on whether billing is on, which is read from the server environment on each request.
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return verticalsAllowed() ? VERTICAL_SLUGS.map((vertical) => ({ vertical })) : [];
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
  // The vertical pages are calltrainer.tech marketing; a tenant without a public landing or pricing does not serve them.
  if (!l || !verticalsAllowed()) notFound();
  return <LandingPage l={l} billingEnabled={billingOn()} />;
}

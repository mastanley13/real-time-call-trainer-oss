"use client";

import Link from "next/link";
import { usePricingViewer } from "@/components/landing/PricingViewer";
import { HERO_SIGNUP_CTA, signedInHeroCta, type PricingViewer } from "@/lib/pricing";

/** The top /pricing button for a known viewer: the unchanged sign-up button when signed out (null), else signedInHeroCta. */
export function PricingHeroCtaView({ viewer, billingEnabled }: { viewer: PricingViewer | null; billingEnabled: boolean }) {
  const cta = viewer ? signedInHeroCta(viewer, billingEnabled) : HERO_SIGNUP_CTA;
  return <Link href={cta.href} className="btn-primary btn-xl">{cta.label}</Link>;
}

/** Reads the viewer from PricingViewerProvider. Anonymous visitors get exactly the old "Start free, no card" link. */
export default function PricingHeroCta({ billingEnabled }: { billingEnabled: boolean }) {
  return <PricingHeroCtaView viewer={usePricingViewer()} billingEnabled={billingEnabled} />;
}

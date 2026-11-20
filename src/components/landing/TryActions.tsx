"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TRY_DEMO_LABEL, TRY_PRIMARY_LABEL, tryDemoHref, tryRegisterHref, tryRole, utmParams, type TryRoleSlug } from "@/lib/tryRoles";

/** The two /try buttons with no query: the Suspense fallback, so the static HTML still has working links. */
export function TryActionsStatic({ slug }: { slug: TryRoleSlug }) {
  const role = tryRole(slug);
  if (!role) return null;
  return <Row registerHref={tryRegisterHref(role)} demoHref={tryDemoHref()} />;
}

/**
 * The two /try buttons, with the current utm_* params copied onto /register, into the next path inside it, and onto
 * /demo. useSearchParams needs a Suspense boundary; the page provides it.
 */
export default function TryActions({ slug }: { slug: TryRoleSlug }) {
  const utm = utmParams(useSearchParams());
  const role = tryRole(slug);
  if (!role) return null;
  return <Row registerHref={tryRegisterHref(role, utm)} demoHref={tryDemoHref(utm)} />;
}

function Row({ registerHref, demoHref }: { registerHref: string; demoHref: string }) {
  return (
    <div className="mt-8 flex flex-col gap-3 sm:flex-row">
      <Link href={registerHref} className="btn-primary btn-xl">{TRY_PRIMARY_LABEL}</Link>
      {/* A plain link: /demo redirects to the booking site, so it should be a full page load. */}
      <a href={demoHref} className="btn-ghost btn-xl">{TRY_DEMO_LABEL}</a>
    </div>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { SessionPreview } from "@/components/landing/LandingPage";
import PublicFooter from "@/components/landing/PublicFooter";
import { LIBRARY } from "@/lib/personas";
import TryActions, { TryActionsStatic } from "@/components/landing/TryActions";
import { TRY_NOTE, TRY_ROLE_SLUGS, tryRole } from "@/lib/tryRoles";
import { pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return TRY_ROLE_SLUGS.map((role) => ({ role }));
}

type Props = { params: Promise<{ role: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { role } = await params;
  const r = tryRole(role);
  if (!r) return {};
  return pageMetadata({ title: r.title, description: r.description, path: `/try/${r.slug}` });
}

/** Try before a sales call: one headline, three lines, start a free text call or book a demo. Copy in src/lib/tryRoles.ts. */
export default async function TryPage({ params }: Props) {
  const { role } = await params;
  const r = tryRole(role);
  if (!r) notFound();
  const scenario = LIBRARY.find((s) => s.id === r.personaId);
  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page grid gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center lg:gap-14">
          <div className="min-w-0">
            <p className="eyebrow">{r.eyebrow}</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] sm:text-[52px]">{r.headline}</h1>
            <ul className="mt-6 max-w-2xl space-y-2.5 text-lg leading-relaxed text-ink-soft">
              {r.bullets.map((b) => (
                <li key={b} className="flex gap-3">
                  <span className="lamp lamp-ok mt-[0.6em] shrink-0" aria-hidden />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <Suspense fallback={<TryActionsStatic slug={r.slug} />}>
              <TryActions slug={r.slug} />
            </Suspense>
            <p className="mt-4 text-sm text-ink-muted">{TRY_NOTE}</p>
          </div>
          {scenario && <SessionPreview scenario={scenario} label="Your first call" />}
        </div>
      </section>
      <PublicFooter />
    </div>
  );
}

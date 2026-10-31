import Link from "next/link";
import PricingSummary from "@/components/landing/PricingSummary";
import PublicFooter from "@/components/landing/PublicFooter";
import { CLOSING, PARTNER_BENEFITS, PARTNER_RULES, type Landing } from "@/lib/landing";
import { registerHref } from "@/lib/pricing";

/** Shared layout for the /for/* vertical landing pages. Static; copy comes from src/lib/landing.ts. */
export default function LandingPage({ l }: { l: Landing }) {
  const partner = l.slug === "coaches";
  const external = l.primaryHref.startsWith("mailto:");
  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page py-14 sm:py-20">
          <p className="eyebrow">{l.audience}</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] sm:text-[52px]">{l.hero}</h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">{l.subhead}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {external
              ? <a href={l.primaryHref} className="btn-primary btn-xl">{l.primaryLabel}</a>
              : <Link href={l.primaryHref} className="btn-primary btn-xl">{l.primaryLabel}</Link>}
            <Link href={l.secondary.href} className="btn-ghost btn-xl">{l.secondary.label}</Link>
          </div>
        </div>
      </section>

      <section className="page py-12 sm:py-14" aria-labelledby="pain-h">
        <h2 id="pain-h" className="sr-only">Problems we hear about</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {l.pains.map((p) => (
            <div key={p.title} className="card">
              <h3 className="text-base font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="how-h">
        <div className="page py-12">
          <p className="eyebrow">How it works</p>
          <h2 id="how-h" className="mt-1 text-2xl font-bold sm:text-3xl">{partner ? "From application to commission" : "Brief, call, debrief. Then go again."}</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {l.steps.map((s, i) => (
              <li key={s.title} className="rounded-panel border border-line p-4">
                <span className="mono text-xs text-ink-muted">0{i + 1}</span>
                <h3 className="mt-2 text-base font-bold">{s.title}</h3>
                <p className="mt-1.5 text-sm text-ink-soft">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {partner && (
        <section className="page py-12" aria-labelledby="benefits-h">
          <h2 id="benefits-h" className="text-2xl font-bold">Benefits</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">
            {PARTNER_BENEFITS.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </section>
      )}

      <section className="page py-12 sm:py-14" aria-labelledby="personas-h">
        <p className="eyebrow">Personas</p>
        <h2 id="personas-h" className="mt-1 text-2xl font-bold sm:text-3xl">{partner ? "A taste of the library" : "Buyers you can practice on today"}</h2>
        <ul className="mt-6 grid gap-4 md:grid-cols-3">
          {l.personas.map((p) => (
            <li key={p.name} className="card">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{p.name}</h3>
                {p.tag && <span className="chip">{p.tag}</span>}
              </div>
              <p className="mt-2 text-sm text-ink-soft">{p.blurb}</p>
            </li>
          ))}
        </ul>
        {l.comingSoon && (
          <div className="panel mt-4 p-5">
            <p className="label">{l.comingSoon.label}</p>
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {l.comingSoon.names.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        )}
      </section>

      {partner && (
        <section className="border-y border-line bg-surface" aria-labelledby="rules-h">
          <div className="page py-12">
            <h2 id="rules-h" className="text-2xl font-bold">Partner rules</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-soft">
              {PARTNER_RULES.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        </section>
      )}

      <PricingSummary src={l.src} seg={l.seg} />

      <section className="page pb-12" aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-2xl font-bold">Questions</h2>
        <div className="mt-6 max-w-3xl divide-y divide-line rounded-panel border border-line bg-surface">
          {l.faq.map((f) => (
            <details key={f.q} className="px-5 py-4">
              <summary className="cursor-pointer list-none font-medium text-ink marker:content-none">{f.q}</summary>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="deck">
        <div className="page py-14 text-center">
          <p className="mx-auto max-w-2xl font-heading text-2xl font-bold sm:text-3xl">{CLOSING}</p>
          <Link href={partner ? registerHref({ src: "coaches" }) : l.primaryHref} className="btn-primary btn-xl mt-6">Start free, no card</Link>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

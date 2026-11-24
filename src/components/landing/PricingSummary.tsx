import Link from "next/link";
import {
  FREE_VOICE_MIN, OPEN_SOON_LINE, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT, registerHref,
} from "@/lib/pricing";

/**
 * Compact plan summary for landing pages. `src` and `seg` tag the sign-up links. With billing off, Pro and Team read
 * "Start free" with the open-soon line, because checkout is not configured on this server.
 */
export default function PricingSummary({ src, seg, billingEnabled }: { src: string; seg?: string; billingEnabled: boolean }) {
  const plans = [
    {
      name: "Free", price: "$0", note: "",
      body: `${FREE_VOICE_MIN} voice minutes a month, unlimited text sim, live coach, graded debriefs, core persona library.`,
      href: registerHref({ seg, src }), cta: "Start free, no card", soon: false,
    },
    {
      name: "Pro", price: `$${PRICE.pro.month}/mo`, note: `or $${PRICE.pro.year}/yr`,
      body: `${PRO_VOICE_MIN} voice minutes a month, full library, persona wizard, score trends, MFA. Reviewed persona packs: coming soon.`,
      href: registerHref({ plan: "pro", interval: "month", seg, src }), cta: billingEnabled ? "Start Pro" : "Start free", soon: !billingEnabled,
    },
    {
      name: "Team", price: `$${PRICE.team.month}/seat/mo`, note: `or $${PRICE.team.year}/seat/yr, ${TEAM_MIN_SEATS}-seat minimum`,
      body: `${TEAM_VOICE_MIN_PER_SEAT} pooled voice minutes per seat, Team view, assignments, enforced MFA.`,
      href: registerHref({ plan: "team", interval: "month", seg, src }), cta: billingEnabled ? "Start with Team" : "Start free", soon: !billingEnabled,
    },
  ];
  return (
    <section className="page py-12 sm:py-16" aria-labelledby="plans-h">
      <p className="eyebrow">Pricing</p>
      <h2 id="plans-h" className="mt-2 text-2xl font-bold sm:text-[28px]">Start free. Upgrade when you want more voice.</h2>
      <div className="mt-8 grid gap-4 md:grid-cols-3 lg:gap-6">
        {plans.map((p) => {
          const featured = p.name === "Team";
          return (
            <div key={p.name} className={`card flex flex-col ${featured ? "shadow-pop ring-1 ring-primary/40" : ""}`}>
              <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-bold">{p.name}</h3>
                {featured && <span className="chip border-primary/40 bg-primary-soft text-ink"><span className="lamp lamp-signal !h-1.5 !w-1.5" aria-hidden />For managers</span>}
              </div>
              <p className="mt-3 font-mono text-2xl font-semibold tracking-tight tabular-nums text-ink">{p.price}</p>
              <p className="min-h-[1.25rem] font-mono text-xs text-ink-muted">{p.note}</p>
              <p className="mt-3 flex-1 border-t border-line pt-3 text-sm leading-relaxed text-ink-soft">{p.body}</p>
              <Link href={p.href} className={`mt-5 ${featured ? "btn-primary" : "btn-ghost"}`}>{p.cta}</Link>
              {p.soon && <p className="mt-2 text-center text-xs text-ink-muted">{OPEN_SOON_LINE}</p>}
            </div>
          );
        })}
      </div>
      <p className="mt-5 text-sm text-ink-muted">
        No overage charges, ever. Self-hosting stays free under MIT. <Link href="/pricing" className="rounded font-medium text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">See full pricing</Link>.
      </p>
    </section>
  );
}

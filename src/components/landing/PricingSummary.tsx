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
      body: `${PRO_VOICE_MIN} voice minutes a month, full library, persona wizard, score trends, two-factor sign-in (MFA). Reviewed persona packs: coming soon.`,
      href: registerHref({ plan: "pro", interval: "month", seg, src }), cta: billingEnabled ? "Start with Pro" : "Start free", soon: !billingEnabled,
    },
    {
      name: "Team", price: `$${PRICE.team.month}/seat/mo`, note: `or $${PRICE.team.year}/seat/yr, ${TEAM_MIN_SEATS}-seat minimum`,
      body: `${TEAM_VOICE_MIN_PER_SEAT} pooled voice minutes per seat, Team view, assignments, enforced two-factor sign-in (MFA).`,
      href: registerHref({ plan: "team", interval: "month", seg, src }), cta: billingEnabled ? "Start with Team" : "Start free", soon: !billingEnabled,
    },
  ];
  return (
    <section className="page py-12" aria-labelledby="plans-h">
      <p className="eyebrow">Pricing</p>
      <h2 id="plans-h" className="mt-1 text-2xl font-bold sm:text-3xl">Start free. Upgrade when you want more voice.</h2>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {plans.map((p) => (
          <div key={p.name} className="card flex flex-col">
            <h3 className="text-lg font-bold">{p.name}</h3>
            <p className="mt-2 font-heading text-2xl font-bold">{p.price}</p>
            <p className="min-h-[1.25rem] font-mono text-xs text-ink-muted">{p.note}</p>
            <p className="mt-3 flex-1 text-sm text-ink-soft">{p.body}</p>
            <Link href={p.href} className="btn-ghost mt-5">{p.cta}</Link>
            {p.soon && <p className="mt-2 text-center text-xs text-ink-muted">{OPEN_SOON_LINE}</p>}
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-ink-muted">
        No overage charges, ever. Self-hosting stays free under MIT. <Link href="/pricing" className="underline underline-offset-2 hover:text-ink">See full pricing</Link>.
      </p>
    </section>
  );
}

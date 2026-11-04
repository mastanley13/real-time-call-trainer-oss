import Link from "next/link";
import { BillingProvider } from "@/components/landing/BillingContext";
import ComparePlans, { type CompareRow } from "@/components/landing/ComparePlans";
import PricingCards from "@/components/landing/PricingCards";
import PublicFooter from "@/components/landing/PublicFooter";
import {
  FREE_SUMMARY, FREE_VOICE_MIN, MINUTES_ROUNDED_NOTE, PREMIUM_VOICE_CAP_PCT, PREMIUM_COMING_SOON, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT, registerHref,
} from "@/lib/pricing";
import { GITHUB_URL, pageMetadata } from "@/lib/seo";
import { billingOn } from "@/lib/serverConfig";

// The plan buttons depend on whether billing is on, which is read from the server environment on each request.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Pricing: Free, Pro and Team Plans | Call Trainer",
  description: "Sales roleplay with an AI buyer and a coach in your ear. Free, no card. Pro $29/mo. Team $59/seat for managers. No overages.",
  path: "/pricing",
});

const COMPARE: CompareRow[] = [
  { feature: "Price", self: "$0, you pay your own API bill", free: "$0",
    pro: { month: `$${PRICE.pro.month}/mo`, year: `$${PRICE.pro.year}/yr` },
    team: { month: `$${PRICE.team.month}/seat/mo, ${TEAM_MIN_SEATS}-seat min`, year: `$${PRICE.team.year}/seat/yr, ${TEAM_MIN_SEATS}-seat min` } },
  { feature: "Voice minutes", self: "Unlimited (your keys)", free: `${FREE_VOICE_MIN} a month`, pro: `${PRO_VOICE_MIN} a month. ${MINUTES_ROUNDED_NOTE}`, team: `${TEAM_VOICE_MIN_PER_SEAT} per seat, pooled. ${MINUTES_ROUNDED_NOTE}` },
  { feature: "Text sim", self: "Yes", free: "Unlimited", pro: "Unlimited", team: "Unlimited" },
  { feature: "Bring your own OpenAI or ElevenLabs keys", self: "Required", free: "Not needed", pro: "Not needed", team: "Not needed" },
  { feature: "Postgres database", self: "You run it", free: "Managed", pro: "Managed", team: "Managed" },
  { feature: "Live coach channel", self: "Yes", free: "Yes", pro: "Yes", team: "Yes" },
  { feature: "Graded debriefs with transcript quotes", self: "Yes", free: "Yes", pro: "Yes", team: "Yes" },
  { feature: "Persona library", self: "Yes", free: "Full", pro: "Full", team: "Full" },
  { feature: "Reviewed persona packs (Insurance, Solar)", self: "Community", free: "No", pro: "Coming soon", team: "Coming soon" },
  { feature: "Persona wizard", self: "Yes", free: "Yes", pro: "Yes", team: "Yes" },
  { feature: "Team view", self: "You host it", free: "Available to managers", pro: "Available to managers", team: "Available to managers" },
  { feature: "Assignments", self: "You host it", free: "Available to managers", pro: "Available to managers", team: "Available to managers" },
  { feature: "Two-factor sign-in (MFA)", self: "You configure it", free: "Available", pro: "Available", team: "Available" },
  { feature: "Premium AI voice", self: "Your keys", free: "No", pro: "No", team: PREMIUM_COMING_SOON },
  { feature: "Updates and backups", self: "You handle them", free: "Automatic", pro: "Automatic", team: "Automatic" },
  { feature: "Support", self: "GitHub community", free: "Community", pro: "Email", team: "Priority email" },
  { feature: "Overage charges", self: "None", free: "None", pro: "None", team: "None" },
];

const FAQ: { q: string; a: string }[] = [
  { q: "What do I get on Free?", a: `${FREE_SUMMARY} It includes the full persona library, the persona wizard, the live coach and graded debriefs.` },
  { q: "What happens when I hit my voice minute cap?", a: "Voice calls pause until your minutes reset: at your next billing cycle on paid plans, or monthly from your signup date on Free. We never charge overages, ever. The text sim stays fully available, so you can keep practicing, get coached and get graded. You can upgrade anytime if you want more voice minutes now." },
  { q: "Will I ever get a surprise bill?", a: "No. There are no overage charges on any plan. Your price is your price, whatever you use." },
  { q: "Do unused minutes roll over?", a: "No. Paid plans reset at the start of each billing cycle. Free resets monthly from your signup date." },
  { q: "Can I buy more minutes mid-month?", a: `Not as an add-on. Upgrade to a higher plan or add Team seats. Each new seat adds ${TEAM_VOICE_MIN_PER_SEAT} minutes to the pool.` },
  { q: "Does the text sim count against my minutes?", a: "No. The text sim is unlimited on every plan." },
  { q: "Do annual plans get more minutes?", a: "Same monthly minutes, reset each month. Annual just costs 2 months less." },
  { q: "Do I need OpenAI or ElevenLabs keys?", a: "No. The hosted plans include the voice models. You only need keys if you self-host." },
  { q: "Do I need a database?", a: "No. We run and back up the database for hosted plans." },
  { q: "How do Team minutes work?", a: `Each seat adds ${TEAM_VOICE_MIN_PER_SEAT} voice minutes to one shared pool. A rep who practices more can use minutes a lighter user does not. When the pool runs out, voice pauses for the team and the text sim stays on.` },
  { q: "Why a 3-seat minimum on Team?", a: "Team is built for a manager coaching several reps, with one shared pool of voice minutes. Solo reps get the best value on Pro. Team view and assignments are available to managers and owners on any plan." },
  { q: "What are reviewed persona packs?", a: "Industry buyer sets, like final expense, Medicare, P&C insurance and residential solar, with realistic objections and grading tuned to that sale. Each pack is reviewed before release. They are coming soon to Pro and Team." },
  { q: "What does Premium AI voice add?", a: `${PREMIUM_COMING_SOON}. It will be a Team add-on first. The full realtime voice model for your buyers, more natural and expressive. It can use up to ${PREMIUM_VOICE_CAP_PCT}% of your plan minutes. After that, calls fall back to standard voice and never stop. Pricing will be announced when it launches.` },
  { q: "How does annual billing work?", a: `Pay for 10 months, get 12. Pro is $${PRICE.pro.year} a year. Team is $${PRICE.team.year} per seat per year.` },
  { q: "Can I cancel anytime?", a: "Yes. Cancel anytime from Settings > Billing and your access continues until the end of the period you paid for. There are no refunds. Payments to StrategixAI LLC are non-refundable except where the law requires." },
  { q: "What happens to my data?", a: "Transcripts are kept until an admin sets a retention window. No call audio is stored on our servers." },
];

export default function PricingPage() {
  return (
    <div>
      <section className="border-b border-line">
        <div className="page py-14 sm:py-20">
          <p className="eyebrow">Pricing</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] sm:text-5xl">Practice the call before it costs you the deal</h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
            Talk to AI buyers who push back, get coached live, and get a graded debrief that quotes your own transcript. Hosted for you: no API keys, no database, no setup.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href={registerHref({ src: "pricing" })} className="btn-primary btn-xl">Start free, no card</Link>
            <a href="#plans" className="btn-ghost btn-xl">Compare plans</a>
          </div>
          <p className="mt-5 text-sm text-ink-muted">Self-hosting stays free forever under the MIT license.</p>
        </div>
      </section>

      <BillingProvider>
        <section id="plans" className="page py-12 sm:py-14" aria-label="Plans">
          <PricingCards billingEnabled={billingOn()} />
          <p className="mt-4 text-sm text-ink-muted">No overage charges on any plan. Free has no card and resets monthly from your signup date, with no rollover.</p>
          <p className="mt-1 text-sm text-ink-muted">Prices in USD. Sales tax or VAT may be added at checkout where required.</p>
        </section>

        <section className="border-y border-line bg-surface" aria-labelledby="compare-h">
          <div className="page py-12">
            <h2 id="compare-h" className="text-2xl font-bold">Compare plans</h2>
            <ComparePlans rows={COMPARE} />
          </div>
        </section>
      </BillingProvider>

      <section className="page py-12 sm:py-14" aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-2xl font-bold">Questions</h2>
        <div className="mt-6 max-w-3xl divide-y divide-line rounded-panel border border-line bg-surface">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="cursor-pointer list-none font-medium text-ink marker:content-none">{f.q}</summary>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="deck" aria-labelledby="self-h">
        <div className="page py-12">
          <h2 id="self-h" className="text-2xl font-bold">Prefer to run it yourself?</h2>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Real-Time Call Trainer is open source under the MIT license. Self-hosting is free forever, with every core feature: voice roleplay, live coaching, graded debriefs and the persona wizard. You bring your own OpenAI or ElevenLabs keys and your own Postgres. Hosted plans exist for people who would rather practice than run servers.
          </p>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn-ghost mt-5">View on GitHub</a>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

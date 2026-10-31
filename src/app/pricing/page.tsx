import Link from "next/link";
import PricingCards from "@/components/landing/PricingCards";
import PublicFooter from "@/components/landing/PublicFooter";
import {
  FREE_VOICE_MIN, PREMIUM_VOICE_CAP_PCT, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT, registerHref,
} from "@/lib/pricing";
import { GITHUB_URL, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Pricing: Free, Pro and Team Plans | Call Trainer",
  description: "Start free with no card. Pro $29/mo for reps, Team $59/seat for managers. No overages, no API keys. Self-host free under MIT.",
  path: "/pricing",
});

const COMPARE: { feature: string; self: string; free: string; pro: string; team: string }[] = [
  { feature: "Price", self: "$0, you pay your own API bill", free: "$0", pro: `$${PRICE.pro.month}/mo`, team: `$${PRICE.team.month}/seat/mo, ${TEAM_MIN_SEATS}-seat min` },
  { feature: "Voice minutes", self: "Unlimited (your keys)", free: `${FREE_VOICE_MIN} a month`, pro: `${PRO_VOICE_MIN} a month`, team: `${TEAM_VOICE_MIN_PER_SEAT} per seat, pooled` },
  { feature: "Text sim", self: "Yes", free: "Unlimited", pro: "Unlimited", team: "Unlimited" },
  { feature: "Bring your own OpenAI or ElevenLabs keys", self: "Required", free: "Not needed", pro: "Not needed", team: "Not needed" },
  { feature: "Postgres database", self: "You run it", free: "Managed", pro: "Managed", team: "Managed" },
  { feature: "Live coach channel", self: "Yes", free: "Yes", pro: "Yes", team: "Yes" },
  { feature: "Graded debriefs with transcript quotes", self: "Yes", free: "Yes", pro: "Yes", team: "Yes" },
  { feature: "Persona library", self: "Yes", free: "Core set", pro: "Full", team: "Full" },
  { feature: "Reviewed persona packs (Insurance, Solar)", self: "Community", free: "No", pro: "Coming soon", team: "Coming soon" },
  { feature: "Persona wizard", self: "Yes", free: "No", pro: "Yes", team: "Yes" },
  { feature: "Team view for managers", self: "You host it", free: "No", pro: "No", team: "Managed" },
  { feature: "Assignments", self: "You host it", free: "No", pro: "No", team: "Yes" },
  { feature: "MFA", self: "You configure it", free: "Yes", pro: "Yes", team: "Enforced for team" },
  { feature: "Premium voice", self: "Your keys", free: "No", pro: "Add-on", team: "Add-on" },
  { feature: "Updates and backups", self: "You handle them", free: "Automatic", pro: "Automatic", team: "Automatic" },
  { feature: "Support", self: "GitHub community", free: "Community", pro: "Email", team: "Priority email" },
  { feature: "Overage charges", self: "None", free: "None", pro: "None", team: "None" },
];

const FAQ: { q: string; a: string }[] = [
  { q: "What happens when I hit my voice minute cap?", a: "Voice calls pause until your next billing cycle. We never charge overages, ever. The text sim stays fully available, so you can keep practicing, get coached and get graded. You can upgrade anytime if you want more voice minutes now." },
  { q: "Will I ever get a surprise bill?", a: "No. There are no overage charges on any plan. Your price is your price, whatever you use." },
  { q: "Do unused minutes roll over?", a: "No. Paid plans reset at the start of each billing cycle. Free resets monthly from your signup date." },
  { q: "Can I buy more minutes mid-month?", a: `Not as an add-on. Upgrade to a higher plan or add Team seats. Each new seat adds ${TEAM_VOICE_MIN_PER_SEAT} minutes to the pool.` },
  { q: "Does the text sim count against my minutes?", a: "No. The text sim is unlimited on every plan." },
  { q: "Do annual plans get more minutes?", a: "Same monthly minutes, reset each month. Annual just costs 2 months less." },
  { q: "Do I need OpenAI or ElevenLabs keys?", a: "No. The hosted plans include the voice models. You only need keys if you self-host." },
  { q: "Do I need a database?", a: "No. We run and back up the database for hosted plans." },
  { q: "How do Team minutes work?", a: `Each seat adds ${TEAM_VOICE_MIN_PER_SEAT} voice minutes to one shared pool. A rep who practices more can use minutes a lighter user does not. When the pool runs out, voice pauses for the team and the text sim stays on.` },
  { q: "Why a 3-seat minimum on Team?", a: "Team view and assignments are built for a manager coaching several reps. Solo reps get the best value on Pro." },
  { q: "What are reviewed persona packs?", a: "Industry buyer sets, like final expense, Medicare, P&C insurance and residential solar, with realistic objections and grading tuned to that sale. Each pack is reviewed before release. They are coming soon to Pro and Team." },
  { q: "What does Premium voice add?", a: `The full realtime voice model for your buyers, more natural and expressive. It can use up to ${PREMIUM_VOICE_CAP_PCT}% of your plan minutes. After that, calls fall back to standard voice and never stop. It costs +$${PRICE.premium.month} per seat per month ($${PRICE.premium.year} per seat per year).` },
  { q: "How does annual billing work?", a: `Pay for 10 months, get 12. Pro is $${PRICE.pro.year} a year. Team is $${PRICE.team.year} per seat per year.` },
  { q: "Can I cancel anytime?", a: "Yes. Cancel from the billing portal and your plan stays active until the end of the period you paid for." },
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

      <section id="plans" className="page py-12 sm:py-14" aria-label="Plans">
        <PricingCards />
        <p className="mt-4 text-sm text-ink-muted">No overage charges on any plan. Free has no card and resets monthly from your signup date, with no rollover.</p>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="compare-h">
        <div className="page py-12">
          <h2 id="compare-h" className="text-2xl font-bold">Compare plans</h2>
          <div className="mt-6 overflow-x-auto rounded-panel border border-line">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-sunken text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Feature</th>
                  <th scope="col" className="px-4 py-3 font-medium">Self-host (MIT)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Free</th>
                  <th scope="col" className="px-4 py-3 font-medium">Pro</th>
                  <th scope="col" className="px-4 py-3 font-medium">Team</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((r) => (
                  <tr key={r.feature} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 font-medium text-ink">{r.feature}</th>
                    <td className="px-4 py-3 text-ink-soft">{r.self}</td>
                    <td className="px-4 py-3 text-ink-soft">{r.free}</td>
                    <td className="px-4 py-3 text-ink-soft">{r.pro}</td>
                    <td className="px-4 py-3 text-ink-soft">{r.team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

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

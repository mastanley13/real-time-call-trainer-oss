import { BillingProvider } from "@/components/landing/BillingContext";
import PricingCards from "@/components/landing/PricingCards";
import PublicFooter from "@/components/landing/PublicFooter";
import {
  FREE_SUMMARY, MINUTES_ROUNDED_NOTE, PREMIUM_CALL_LENGTH_NOTE, PREMIUM_COMING_SOON, PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_TEAM, PREMIUM_MINUTES, PRICE,
  TEAM_VOICE_MIN_PER_SEAT,
} from "@/lib/pricing";
import { TEAM_POOL_LINE, TEXT_NO_VOICE_NOTE, WORKBOOK_HEADLINE } from "@/lib/pricingWorkbook";
import { GITHUB_URL, pageMetadata } from "@/lib/seo";
import { billingOn, premiumOnSale } from "@/lib/serverConfig";

// The plan buttons depend on whether billing is on, which is read from the server environment on each request.
export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Pricing: Free, Pro and Team Plans | Call Trainer",
  description: "Sales roleplay with an AI buyer and a coach in your ear. Free, no card. Pro $29/mo. Team $59/seat for managers. No overages.",
  path: "/pricing",
});

/** On sale, the allowance and limits the plan cards used to show, without the add-on price. Pro is per account, Team is pooled. */
const PREMIUM_ON_SALE_TERMS = [
  `On Pro: ${PREMIUM_DISCLOSURE_PRO}`,
  `On Team: ${PREMIUM_DISCLOSURE_TEAM}`,
  PREMIUM_CALL_LENGTH_NOTE,
];

/**
 * The Premium add-on is a status note: no price and no button on this page, on sale or not. On sale (billing on and
 * PREMIUM_VOICE_ON_SALE=true, see serverConfig.premiumOnSale) it keeps the allowance, Team pooling and call-cap terms.
 */
const premiumNote = (onSale: boolean): { badge: string; body: string; terms: string[] } => onSale
  ? {
    badge: "Add-on for Pro and Team",
    body: "A more lifelike, expressive voice for your buyers. Add it at checkout or in billing settings. Premium minutes come out of your plan minutes, not on top. Standard voice is included in your plan.",
    terms: PREMIUM_ON_SALE_TERMS,
  }
  : { badge: PREMIUM_COMING_SOON, body: "This add-on is not available to purchase. Standard voice is included in your plan.", terms: [] };

/** The Premium FAQ answer, without a price. On sale it states the allowance, pooling and call cap. */
const premiumFaqAnswer = (onSale: boolean): string => (onSale
  ? `Premium AI voice is a paid add-on for Pro and Team, chosen at checkout or in billing settings. Pro includes ${PREMIUM_MINUTES} Premium minutes a month. Team includes ${PREMIUM_MINUTES} Premium minutes per seat a month, pooled across the team. Those minutes come out of your plan minutes, not on top. After they are used, your next call uses Standard. A Premium call is capped at the Premium minutes left, and we tell you before it starts. No overages.`
  : `${PREMIUM_COMING_SOON}. Premium AI voice is not available to purchase. Standard voice is included in every plan.`);

const FAQ_BASE: { q: string; a: string }[] = [
  { q: "What do I get on Free?", a: FREE_SUMMARY },
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
  { q: "What does Premium AI voice add?", a: "" },
  { q: "How does annual billing work?", a: `Pay for 10 months, get 12. Pro is $${PRICE.pro.year} a year. Team is $${PRICE.team.year} per seat per year.` },
  { q: "Can I cancel anytime?", a: "Yes. Cancel anytime from Settings > Billing and your access continues until the end of the period you paid for. There are no refunds. Payments to StrategixAI LLC are non-refundable except where the law requires." },
  { q: "What happens to my data?", a: "Transcripts are kept until an admin sets a retention window. No call audio is stored on our servers." },
];

/**
 * Pricing, "Comparison workbook": the headline, then one plan workbook (table on wide screens, a definition list per
 * plan on narrow ones), the Team pool and metering notes, the Premium status note, questions and self-hosting.
 * Every named section has its own heading, so landmark names stay unique and headings go h1, h2, h3 in order.
 */
export default function PricingPage() {
  const onSale = premiumOnSale();
  const premium = premiumNote(onSale);
  const FAQ = FAQ_BASE.map((f) => (f.q === "What does Premium AI voice add?" ? { ...f, a: premiumFaqAnswer(onSale) } : f));
  return (
    <div className="focus-strong text-base leading-6">
      <div className="site-wrap">
        <div className="flex flex-col gap-4 py-10 md:flex-row md:items-end md:justify-between md:gap-10 md:py-16">
          <div className="flex min-w-0 flex-col gap-3">
            <h1 className="max-w-[16ch] text-[36px] font-bold leading-[1.1] sm:text-[42px] lg:text-[48px] lg:leading-[1.08]">{WORKBOOK_HEADLINE}</h1>
            <p className="max-w-[60ch] text-lg leading-7 text-ink-soft">Choose your practice time. Know the monthly bill.</p>
          </div>
          <p className="text-sm leading-5 text-ink-soft md:text-right">Hosted for you.<br />No API keys, no database, no setup.</p>
        </div>
      </div>

      <BillingProvider>
        <section id="plans" aria-labelledby="plans-h" className="site-wrap">
          <PricingCards billingEnabled={billingOn()} premiumOnSale={onSale} />
        </section>
      </BillingProvider>

      <div className="site-wrap">
        <div className="grid gap-8 pb-10 lg:grid-cols-2 lg:gap-10">
          <section aria-labelledby="pool-h" className="flex min-w-0 flex-col gap-3">
            <h2 id="pool-h" className="text-2xl font-bold leading-8">One pool for the team.</h2>
            <p className="max-w-[60ch] text-ink-soft">{TEAM_POOL_LINE}</p>
            <p className="max-w-[60ch] text-sm leading-5 text-ink-soft">
              {`${MINUTES_ROUNDED_NOTE} ${TEXT_NO_VOICE_NOTE} No overage charges on any plan. Free resets monthly from your signup date, with no rollover.`}
            </p>
          </section>
          <section aria-labelledby="premium-h" className="flex min-w-0 flex-col items-start gap-3 rounded-panel bg-sunken p-5 sm:p-6">
            <p><span className="badge-tag border border-line">{premium.badge}</span></p>
            <h2 id="premium-h" className="text-2xl font-bold leading-8">Premium AI voice</h2>
            <p className="max-w-[60ch] text-ink-soft">{premium.body}</p>
            {premium.terms.length > 0 && (
              <ul data-premium-terms className="max-w-[60ch] list-disc space-y-2 pl-5 text-sm leading-5 text-ink-soft">
                {premium.terms.map((t) => <li key={t}>{t}</li>)}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section aria-labelledby="faq-h" className="site-wrap">
        <div className="border-t border-line py-10">
          <h2 id="faq-h" className="text-2xl font-bold leading-8">Questions</h2>
          <div className="mt-6 max-w-3xl divide-y divide-line rounded-panel border border-line bg-surface">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-2">
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center rounded-control font-medium text-ink marker:content-none">{f.q}</summary>
                <p className="pb-2 text-sm leading-relaxed text-ink-soft">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="self-h" className="site-wrap">
        <div className="border-t border-line pb-16 pt-10">
          <h2 id="self-h" className="text-2xl font-bold leading-8">Prefer to run it yourself?</h2>
          <p className="mt-3 max-w-[60ch] text-ink-soft">
            Self-hosting stays free under the MIT license. You bring your own keys and database. Hosted plans are for people who would rather practice than run servers.
          </p>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn-ghost btn-lg mt-5">View on GitHub</a>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

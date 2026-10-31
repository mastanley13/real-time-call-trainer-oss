// Legal copy pending owner review.
import Link from "next/link";
import PublicFooter from "@/components/landing/PublicFooter";
import {
  FREE_VOICE_MIN, PREMIUM_VOICE_CAP_PCT, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT,
} from "@/lib/pricing";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Terms of Service | Call Trainer",
  description: "The terms for using the hosted Real-Time Call Trainer service: plans, billing through Stripe, cancelling anytime and acceptable use.",
  path: "/terms",
});

export default function TermsPage() {
  const mail = <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a>;
  return (
    <div>
      <article className="page max-w-3xl py-12 sm:py-16">
        <p className="eyebrow">Legal</p>
        <h1 className="mt-2 text-4xl font-bold">Terms of Service</h1>
        <p className="mt-3 font-mono text-sm text-ink-muted">Last updated: October 31, 2026</p>
        <p className="mt-6 text-ink-soft">
          These terms cover your use of the hosted service at calltrainer.tech, operated by Strategix AI. By creating an account or using the service, you agree to them. Questions go to {mail}.
        </p>

        <h2 className="mt-10 text-xl font-bold">Plans</h2>
        <p className="mt-3 text-ink-soft">Plans are as described on the <Link href="/pricing" className="underline underline-offset-2">pricing page</Link>:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">
          <li>Free: $0, {FREE_VOICE_MIN} voice minutes a month, no card.</li>
          <li>Pro: ${PRICE.pro.month} a month or ${PRICE.pro.year} a year, {PRO_VOICE_MIN} voice minutes a month.</li>
          <li>Team: ${PRICE.team.month} per seat a month or ${PRICE.team.year} per seat a year, {TEAM_VOICE_MIN_PER_SEAT} pooled voice minutes per seat, {TEAM_MIN_SEATS} seat minimum.</li>
          <li>Premium voice add-on: +${PRICE.premium.month} per seat a month (${PRICE.premium.year} per seat a year), capped at {PREMIUM_VOICE_CAP_PCT}% of plan minutes, after which calls use standard voice.</li>
        </ul>
        <p className="mt-3 text-ink-soft">Voice minutes reset each month and do not roll over. There are no overage charges. The text sim is unlimited on every plan.</p>

        <h2 className="mt-10 text-xl font-bold">Billing</h2>
        <p className="mt-3 text-ink-soft">Paid plans are billed monthly or annually through Stripe. We never see your card numbers. Annual billing costs 10 months for 12.</p>

        <h2 className="mt-10 text-xl font-bold">Cancelling</h2>
        <p className="mt-3 text-ink-soft">You can cancel anytime from the billing portal. Your plan stays active until the end of the period you paid for.</p>

        <h2 className="mt-10 text-xl font-bold">Acceptable use</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">
          <li>Use the service to practice calls and train your team, not to break the law or harm others.</li>
          <li>Do not try to break, overload or get around the limits of the service.</li>
          <li>Do not share your account or use it to resell the service.</li>
          <li>Do not upload other people&rsquo;s private information that you have no right to use.</li>
        </ul>
        <p className="mt-3 text-ink-soft">The service is practice roleplay. It is not legal, compliance or financial advice. Always follow the rules that apply to your industry and your employer.</p>

        <h2 className="mt-10 text-xl font-bold">No warranty</h2>
        <p className="mt-3 text-ink-soft">The service is provided as is, without warranties of any kind. AI buyers, coaching and grades can be wrong. To the extent the law allows, Strategix AI is not liable for indirect or consequential losses from using the service.</p>

        <h2 className="mt-10 text-xl font-bold">Open-source code</h2>
        <p className="mt-3 text-ink-soft">The Real-Time Call Trainer source code is open source under the MIT license, which covers the code. These terms cover the hosted service.</p>

        <h2 className="mt-10 text-xl font-bold">Your data</h2>
        <p className="mt-3 text-ink-soft">See the <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link> for what we collect and how long we keep it.</p>

        <h2 className="mt-10 text-xl font-bold">Changes and contact</h2>
        <p className="mt-3 text-ink-soft">If we change these terms, we will update the date at the top of this page. Contact: {mail}.</p>
      </article>
      <PublicFooter />
    </div>
  );
}

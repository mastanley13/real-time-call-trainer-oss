// Legal copy pending owner review.
import type { Metadata } from "next";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms for using the Call Trainer hosted service: plans, billing, cancellation and refunds, acceptable use and liability.",
};

export default function TermsPage() {
  return (
    <>
    <div className="page max-w-3xl py-12 sm:py-16">
      <p className="eyebrow">Legal</p>
      <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Terms of service</h1>
      <p className="mt-2 font-mono text-xs text-ink-muted">Last updated: November 4, 2026</p>

      <div className="mt-8 space-y-8 text-ink-soft">
        <section aria-labelledby="service-h">
          <h2 id="service-h" className="text-xl font-bold text-ink">The service</h2>
          <p className="mt-2">Call Trainer at calltrainer.tech is a hosted service run by StrategixAI LLC. By using it you agree to these terms.</p>
        </section>

        <section aria-labelledby="account-h">
          <h2 id="account-h" className="text-xl font-bold text-ink">Your account</h2>
          <p className="mt-2">You can sign in with an email and password or with Google. If you use Google, Google&apos;s own terms apply to your Google account, and you are responsible for keeping it secure. Keep your sign-in details to yourself.</p>
        </section>

        <section aria-labelledby="billing-h">
          <h2 id="billing-h" className="text-xl font-bold text-ink">Plans and billing</h2>
          <p className="mt-2">Free accounts include 10 voice minutes a month and unlimited text practice. Paid plans (Pro and Team) are available by monthly or annual subscription at the prices on /pricing. There are no overage charges. There are no refunds. You can cancel anytime and keep access until the end of the period you have paid for. See Billing, cancellation and refunds below.</p>
        </section>

        <section aria-labelledby="cancel-h">
          <h2 id="cancel-h" className="text-xl font-bold text-ink">Billing, cancellation and refunds</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Subscriptions renew automatically, monthly or annually depending on the plan you choose.</li>
            <li>You can cancel anytime from Settings &gt; Billing.</li>
            <li>After you cancel, you keep access until the end of the period you have paid for.</li>
            <li>Payments to StrategixAI LLC are non-refundable except where the law requires.</li>
          </ul>
          <p className="mt-2">Questions about a charge: support@calltrainer.tech.</p>
        </section>

        <section aria-labelledby="use-h">
          <h2 id="use-h" className="text-xl font-bold text-ink">Acceptable use</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Do not use the service for anything unlawful.</li>
            <li>Do not abuse the AI services.</li>
            <li>Do not resell access.</li>
          </ul>
        </section>

        <section aria-labelledby="ending-h">
          <h2 id="ending-h" className="text-xl font-bold text-ink">Ending access</h2>
          <p className="mt-2">You can stop using the service at any time. We may suspend accounts that break these terms.</p>
        </section>

        <section aria-labelledby="warranty-h">
          <h2 id="warranty-h" className="text-xl font-bold text-ink">No warranty</h2>
          <p className="mt-2">The service is provided as is, without warranty of any kind.</p>
        </section>

        <section aria-labelledby="liability-h">
          <h2 id="liability-h" className="text-xl font-bold text-ink">Limitation of liability</h2>
          <p className="mt-2">To the extent the law allows, StrategixAI LLC is not liable for indirect, incidental or consequential damages arising from your use of the service.</p>
        </section>

        <section aria-labelledby="law-h">
          <h2 id="law-h" className="text-xl font-bold text-ink">Governing law</h2>
          <p className="mt-2">These terms are governed by the laws of North Carolina.</p>
        </section>

        <section aria-labelledby="oss-h">
          <h2 id="oss-h" className="text-xl font-bold text-ink">Open-source code</h2>
          <p className="mt-2">The open-source code is separately licensed under the MIT license. These terms cover the hosted service only.</p>
        </section>

        <section aria-labelledby="changes-h">
          <h2 id="changes-h" className="text-xl font-bold text-ink">Changes</h2>
          <p className="mt-2">We may update these terms. We will post the date of the latest update at the top of this page.</p>
        </section>

        <section aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-xl font-bold text-ink">Contact</h2>
          <p className="mt-2">Questions about these terms: support@calltrainer.tech.</p>
        </section>
      </div>
    </div>
    <SiteFooter />
    </>
  );
}

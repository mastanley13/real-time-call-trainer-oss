// Legal copy pending owner review.
import type { Metadata } from "next";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Call Trainer collects, who processes it, and how to ask for export or deletion.",
};

export default function PrivacyPage() {
  return (
    <>
    <div className="page max-w-3xl py-12 sm:py-16">
      <p className="eyebrow">Legal</p>
      <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Privacy policy</h1>
      <p className="mt-2 font-mono text-xs text-ink-muted">Last updated: October 31, 2026</p>

      <div className="mt-8 space-y-8 text-ink-soft">
        <section aria-labelledby="who-h">
          <h2 id="who-h" className="text-xl font-bold text-ink">Who we are</h2>
          <p className="mt-2">Strategix AI operates calltrainer.tech. This policy explains what personal data the service collects and how it is used.</p>
        </section>

        <section aria-labelledby="collect-h">
          <h2 id="collect-h" className="text-xl font-bold text-ink">What we collect</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Account data: your name, email address and a password hash. If you sign in with Google, we receive only your email and basic profile (name and picture).</li>
            <li>Practice call transcripts and scores. We store them and keep them until an admin sets a retention window.</li>
            <li>No call audio is stored on our servers.</li>
          </ul>
        </section>

        <section aria-labelledby="processors-h">
          <h2 id="processors-h" className="text-xl font-bold text-ink">Who processes it for us</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>OpenAI and ElevenLabs process voice and AI requests as processors.</li>
            <li>Stripe handles payments. We never see or store card numbers.</li>
            <li>HighLevel sends account and billing follow-up emails.</li>
          </ul>
        </section>

        <section aria-labelledby="sell-h">
          <h2 id="sell-h" className="text-xl font-bold text-ink">Selling data</h2>
          <p className="mt-2">We do not sell personal data.</p>
        </section>

        <section aria-labelledby="cookies-h">
          <h2 id="cookies-h" className="text-xl font-bold text-ink">Cookies</h2>
          <p className="mt-2">We use security cookies only, to keep you signed in.</p>
        </section>

        <section aria-labelledby="rights-h">
          <h2 id="rights-h" className="text-xl font-bold text-ink">Export and deletion</h2>
          <p className="mt-2">You can ask for a copy of your data or ask us to delete it. Email <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a>.</p>
        </section>

        <section aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-xl font-bold text-ink">Contact</h2>
          <p className="mt-2">Questions about this policy: <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a>.</p>
        </section>
      </div>
    </div>
    <SiteFooter />
    </>
  );
}

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
          <p className="mt-2">[LEGAL ENTITY] operates calltrainer.tech. This policy explains what personal data the service collects and how it is used.</p>
        </section>

        <section aria-labelledby="collect-h">
          <h2 id="collect-h" className="text-xl font-bold text-ink">What we collect</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Account data: your name, email address and a password hash. If you sign in with Google, we receive your name and email address from Google.</li>
            <li>If you turn on two-factor sign-in, we store the authenticator secret needed to check your codes.</li>
            <li>Practice call transcripts, scores, coaching notes and any scenario details you enter, including text you give the persona wizard about what you sell and your industry. We keep them until an admin sets a retention window for the organization.</li>
            <li>Security logs: the IP address and browser details (user agent) for sign-in and account events.</li>
            <li>We do not record or store call audio. During a voice call, your audio streams directly to our voice provider (OpenAI or ElevenLabs) to run the call.</li>
          </ul>
        </section>

        <section aria-labelledby="processors-h">
          <h2 id="processors-h" className="text-xl font-bold text-ink">Who processes it for us</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>OpenAI and ElevenLabs run the voice calls and the AI that plays the buyer, coaches and grades you. Live call audio, transcripts, and wizard and scenario text go to them for that purpose.</li>
            <li>Vercel hosts the site.</li>
            <li>Neon stores the database.</li>
            <li>Google provides sign-in if you choose Sign in with Google.</li>
          </ul>
        </section>

        <section aria-labelledby="sell-h">
          <h2 id="sell-h" className="text-xl font-bold text-ink">Selling data</h2>
          <p className="mt-2">We do not sell personal data.</p>
        </section>

        <section aria-labelledby="cookies-h">
          <h2 id="cookies-h" className="text-xl font-bold text-ink">Cookies and local storage</h2>
          <p className="mt-2">We use cookies only to keep you signed in and to secure the sign-in flow. Your browser also stores display settings, such as light or dark theme, on your device. These settings do not leave your device.</p>
        </section>

        <section aria-labelledby="children-h">
          <h2 id="children-h" className="text-xl font-bold text-ink">Children</h2>
          <p className="mt-2">The service is not meant for anyone under 16, and we do not knowingly collect their data.</p>
        </section>

        <section aria-labelledby="rights-h">
          <h2 id="rights-h" className="text-xl font-bold text-ink">Export and deletion</h2>
          <p className="mt-2">Email [SUPPORT EMAIL] and we will send a copy of your data or delete your account within 30 days.</p>
        </section>

        <section aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-xl font-bold text-ink">Contact</h2>
          <p className="mt-2">Questions about this policy: [SUPPORT EMAIL].</p>
        </section>
      </div>
    </div>
    <SiteFooter />
    </>
  );
}

// Legal copy pending owner review.
import type { Metadata } from "next";
import SiteFooter from "@/components/SiteFooter";
import { brand, siteHost } from "@/lib/tenant";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: `What ${brand.shortName} collects, who processes it, and how to ask for export or deletion.`,
};

export default function PrivacyPage() {
  return (
    <>
    <div className="page max-w-3xl py-12 sm:py-16">
      <p className="eyebrow">Legal</p>
      <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Privacy policy</h1>
      <p className="mt-2 font-mono text-xs text-ink-muted">Last updated: November 4, 2026</p>

      <div className="mt-8 space-y-8 text-ink-soft">
        <section aria-labelledby="who-h">
          <h2 id="who-h" className="text-xl font-bold text-ink">Who we are</h2>
          <p className="mt-2">{brand.operatorName} operates {siteHost}. This policy explains what personal data the service collects and how it is used.</p>
        </section>

        <section aria-labelledby="collect-h">
          <h2 id="collect-h" className="text-xl font-bold text-ink">What we collect</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Account data: your name, email address and a password hash. If you create your account with Google, there is no password.</li>
            <li>If you sign in with Google, we keep your email address, your first and last name and your Google account id. We confirm Google verified your email but do not store that check, any Google token or your photo. If you already had an account, we only add your Google account id.</li>
            <li>If you turn on two-factor sign-in, we store the authenticator secret needed to check your codes.</li>
            <li>Billing data, if you buy a plan: your plan, seat count, subscription status and Stripe customer id.</li>
            <li>Usage records: the voice minutes each call used and when it ran. We keep these after transcripts are deleted so monthly minute limits and billing stay correct.</li>
            <li>Practice call transcripts, scores, coaching notes and any scenario details you enter, including text you give the persona wizard about what you sell and your industry. We keep them until an admin sets a retention window for the organization.</li>
            <li>Team data, if your organization uses the team view: training assignments that managers give you, your progress on them, and supervisor notes about your sessions. Managers and owners in your organization can see this data.</li>
            <li>Security logs: the IP address and browser details (user agent) for sign-in and account events.</li>
            <li>We do not record or store call audio. During a voice call, your audio streams directly to our voice provider (OpenAI or ElevenLabs) to run the call.</li>
          </ul>
        </section>

        <section aria-labelledby="processors-h">
          <h2 id="processors-h" className="text-xl font-bold text-ink">Who processes it for us</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>OpenAI and ElevenLabs run the voice calls and the AI that plays the buyer, coaches and grades you. Live call audio, transcripts, and wizard and scenario text go to them for that purpose.</li>
            <li>Google provides sign-in if you choose Continue with Google. Google tells us who you are when you sign in. We do not send Google your practice calls or other data.</li>
            <li>Vercel hosts the site.</li>
            <li>Neon stores the database.</li>
            <li>Stripe will process payments when paid plans open. We store your Stripe customer and subscription ids and your plan, not your card details.</li>
          </ul>
        </section>

        <section aria-labelledby="sell-h">
          <h2 id="sell-h" className="text-xl font-bold text-ink">Selling data</h2>
          <p className="mt-2">We do not sell personal data.</p>
        </section>

        <section aria-labelledby="cookies-h">
          <h2 id="cookies-h" className="text-xl font-bold text-ink">Cookies and local storage</h2>
          <p className="mt-2">We use cookies to keep you signed in, to secure the sign-in flow and, while the site is invite only, to remember for 30 days that you entered a valid invite code. If you use Continue with Google, a short-lived cookie protects that sign-in and remembers any plan you picked on our pricing page, for up to 10 minutes, and is deleted when it finishes. Your browser&apos;s local storage also keeps your sign-in token and basic profile so you stay signed in, the custom personas you create in the editor or persona wizard, and preferences such as light or dark theme, coach mode, voice engine, your last scenario and your Team view date range. An unsaved persona draft is kept in session storage until you close the tab. Personas and preferences stored this way stay on your device unless you start a call with them, with two exceptions. In the persona wizard, the details you enter, any page you import by URL and the context you paste are sent to our servers and, when AI drafting is on, to our AI provider to draft the persona. Your Team view date range is sent to our servers to load Team results.</p>
        </section>

        <section aria-labelledby="children-h">
          <h2 id="children-h" className="text-xl font-bold text-ink">Children</h2>
          <p className="mt-2">The service is not meant for anyone under 16, and we do not knowingly collect their data.</p>
        </section>

        <section aria-labelledby="rights-h">
          <h2 id="rights-h" className="text-xl font-bold text-ink">Export and deletion</h2>
          <p className="mt-2">Email {brand.supportEmail} and we will send a copy of your data or delete your account within 30 days. If you signed in with Google, we can also remove the link to your Google account. You can stop {brand.shortName} from using your Google sign-in at any time from your Google Account settings (myaccount.google.com, Security, Third-party apps); that does not delete your {brand.shortName} account, so email us if you want it deleted.</p>
        </section>

        <section aria-labelledby="contact-h">
          <h2 id="contact-h" className="text-xl font-bold text-ink">Contact</h2>
          <p className="mt-2">Questions about this policy: {brand.supportEmail}.</p>
        </section>
      </div>
    </div>
    <SiteFooter />
    </>
  );
}

// Legal copy pending owner review.
import PublicFooter from "@/components/landing/PublicFooter";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Privacy Policy | Call Trainer",
  description: "What Real-Time Call Trainer collects, who processes it and how long we keep it. No call audio is stored on our servers, and we never sell your data.",
  path: "/privacy",
});

const SUBPROCESSORS = [
  { name: "OpenAI", job: "Processes voice during calls." },
  { name: "ElevenLabs", job: "Processes voice during calls." },
  { name: "Stripe", job: "Handles payments. We never see your card numbers." },
  { name: "HighLevel", job: "Handles CRM follow-up." },
];

export default function PrivacyPage() {
  return (
    <div>
      <article className="page max-w-3xl py-12 sm:py-16">
        <p className="eyebrow">Legal</p>
        <h1 className="mt-2 text-4xl font-bold">Privacy Policy</h1>
        <p className="mt-3 font-mono text-sm text-ink-muted">Last updated: October 31, 2026</p>
        <p className="mt-6 text-ink-soft">
          This policy covers the hosted service at calltrainer.tech, run by Strategix AI. It explains what we collect, who helps us run the service and how long we keep your data. Questions go to <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a>.
        </p>

        <h2 className="mt-10 text-xl font-bold">What we collect</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-ink-soft">
          <li><strong className="text-ink">Account data.</strong> Your name and email. If you sign in with Google, we also receive your basic Google profile information.</li>
          <li><strong className="text-ink">Transcripts.</strong> The text of your practice calls and their grades, so you can review your debriefs and track progress.</li>
        </ul>

        <h2 className="mt-10 text-xl font-bold">Call audio</h2>
        <p className="mt-3 text-ink-soft">No call audio is stored on our servers. Voice is streamed to our voice providers while a call is live, and we keep the transcript, not the recording.</p>

        <h2 className="mt-10 text-xl font-bold">How long we keep transcripts</h2>
        <p className="mt-3 text-ink-soft">Transcripts are kept until an admin sets a retention window.</p>

        <h2 className="mt-10 text-xl font-bold">Who processes your data</h2>
        <p className="mt-3 text-ink-soft">We use these subprocessors to run the service:</p>
        <ul className="mt-3 space-y-2 text-ink-soft">
          {SUBPROCESSORS.map((s) => (
            <li key={s.name} className="rounded-panel border border-line bg-surface px-4 py-3"><strong className="text-ink">{s.name}.</strong> {s.job}</li>
          ))}
        </ul>

        <h2 className="mt-10 text-xl font-bold">We do not sell your data</h2>
        <p className="mt-3 text-ink-soft">We do not sell your data.</p>

        <h2 className="mt-10 text-xl font-bold">Your choices</h2>
        <p className="mt-3 text-ink-soft">Email <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a> to ask for a copy of your data, a correction or deletion of your account.</p>

        <h2 className="mt-10 text-xl font-bold">Changes</h2>
        <p className="mt-3 text-ink-soft">If we change this policy, we will update the date at the top of this page.</p>

        <h2 className="mt-10 text-xl font-bold">Contact</h2>
        <p className="mt-3 text-ink-soft">Strategix AI, operator of calltrainer.tech. <a className="underline underline-offset-2" href="mailto:support@calltrainer.tech">support@calltrainer.tech</a></p>
      </article>
      <PublicFooter />
    </div>
  );
}

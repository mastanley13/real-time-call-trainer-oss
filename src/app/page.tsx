import Link from "next/link";
import { FileJson, GitPullRequest, KeyRound, LibraryBig, MessageSquareQuote, Radar } from "lucide-react";
import HeroDeck from "@/components/landing/HeroDeck";
import PublicFooter from "@/components/landing/PublicFooter";
import "@/components/landing/landing-desk.css";
import { LIBRARY } from "@/lib/personas";
import { registerHref } from "@/lib/pricing";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
  description:
    "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
  path: "/",
});

const families = new Set(LIBRARY.map((s) => s.role)).size;

const STEPS = [
  { title: "Brief", body: "Pick a persona from the library. Read the goal, the objections to expect and the talk track." },
  { title: "Call", body: "Talk or type. The caller stays in character; a coach rail only you can see scores each turn and whispers the next move." },
  { title: "Debrief", body: "Every score cites your own words. Jump to the moment you lost points and retry the call from that turn." },
];

// Provider names only, never model ids: operators pick models with LLM_MODEL and REALTIME_MODEL on the server.
const MODELS = [
  { job: "Live coach", engine: "Your chat model", note: "Per-turn cues and rubric estimate, as validated JSON" },
  { job: "Grading", engine: "Your chat model", note: "Full-transcript rubric grade with verbatim evidence checks" },
  { job: "Persona wizard", engine: "Your chat model", note: "Builds a persona, objections and rubric from your context" },
  { job: "Voice", engine: "OpenAI Realtime", note: "Over WebRTC, the default when an OpenAI key is set. ElevenLabs Agents also supported" },
];

const FEATURES = [
  { icon: LibraryBig, title: `${LIBRARY.length} AI buyers across ${families} sales jobs`, body: "From SDR cold calls to insurance renewals, portal leads and past-due calls. Filter by role, industry, difficulty and the objection they throw." },
  { icon: Radar, title: "A live coach, not a script", body: "A live score on every turn, talk-track progress and a line your rep can use. Train Blind, Guided or Coached, so you choose how much help each rep gets." },
  { icon: MessageSquareQuote, title: "A debrief that quotes your rep's own words", body: "Every score cites what the rep actually said, checked against the transcript. Open a quote to see the moment, then retry the call from that turn." },
];

/** Small primary label above a heading (the Practice Desk form of the eyebrow). */
const LABEL = "text-sm font-semibold leading-5 text-primary";
const H2 = "text-2xl font-bold leading-8 sm:text-[27px] sm:leading-9";

/**
 * Practice Desk landing. Static and server-rendered: no client code, so nothing here can ask for the microphone.
 * The .landing-desk wrapper scopes its tokens, type, radii, gutters and focus ring (landing-desk.css); the footer
 * stays outside it so the shared chrome looks the same as on every other page.
 */
export default function Home() {
  return (
    <>
      <div className="landing-desk">
        <section aria-labelledby="hero-h" className="desk-wrap">
          <div className="grid items-center gap-10 py-10 md:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="flex min-w-0 flex-col gap-6">
              <p className={LABEL}>Free tier · no card · text or voice</p>
              <h1 id="hero-h" className="-mt-2 max-w-[20ch] text-[36px] font-bold leading-[1.1] sm:text-[42px] lg:text-[56px] lg:leading-[1.08]">
                Know which reps are ready before they&apos;re on a live call.
              </h1>
              <p className="max-w-[60ch] text-lg leading-7 text-ink-soft">
                {`Your reps practice against ${LIBRARY.length} AI buyers who push back. You read a graded debrief that quotes their own words, so you can see who is ready and what to coach next. Free to start, no card.`}
              </p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link href={registerHref({ src: "home_hero" })} className="btn-primary desk-btn">Start free, no card</Link>
                <Link href="/pricing" className="desk-link">See pricing</Link>
              </div>
              <p className="max-w-[60ch] text-sm leading-5 text-ink-soft">
                {"Managing 3 or more reps? Team adds a manager view and assignments: $59 a seat a month, 3-seat minimum. "}
                <Link href="/register?src=home_hero&plan=team&interval=month" className="rounded font-medium text-primary underline underline-offset-4">Start a Team</Link>
              </p>
            </div>
            <HeroDeck />
          </div>
        </section>

        <section aria-labelledby="how-h" className="desk-wrap">
          <div className="border-t border-line pb-16 pt-6">
            <p className={LABEL}>How it works</p>
            <h2 id="how-h" className={`mt-1 ${H2}`}>Brief, call, debrief. Then go again.</h2>
            <ol role="list" className="mt-10 grid list-none gap-8 md:grid-cols-3 md:gap-10">
              {STEPS.map((s, i) => (
                <li key={s.title} className="min-w-0">
                  <h3 className="text-base font-semibold leading-6 text-primary"><span aria-hidden="true">{i + 1}. </span>{s.title}</h3>
                  <p className="mt-2 max-w-[60ch] text-ink-soft">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="models-h" className="desk-wrap">
          <div className="border-t border-line pb-16 pt-6">
            <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
              <div className="min-w-0">
                <p className={LABEL}>Under the hood</p>
                <h2 id="models-h" className={`mt-1 ${H2}`}>What runs each job</h2>
              </div>
              <p className="max-w-[60ch] text-sm leading-6 text-ink-soft">Coaching, grades, wizard drafts and text-call replies say whether AI produced them or a rules-based fallback did. Point <span className="mono">LLM_BASE_URL</span> at any OpenAI-compatible API, with its own <span className="mono">LLM_API_KEY</span>, and set <span className="mono">LLM_MODEL</span> to swap models.</p>
            </div>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              {MODELS.map((m) => (
                <div key={m.job} className="desk-panel min-w-0 p-5">
                  <p className="text-sm font-semibold leading-5 text-ink">{m.job}</p>
                  <p className="desk-badge mt-2">{m.engine}</p>
                  <p className="mt-3 text-ink-soft">{m.note}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="feat-h" className="desk-wrap">
          <div className="pb-16">
            <h2 id="feat-h" className="sr-only">Features</h2>
            <ul role="list" className="grid list-none gap-4 md:grid-cols-3 md:gap-6">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li key={title} className="desk-panel min-w-0 p-5 md:p-6">
                  <span className="desk-icon"><Icon size={20} strokeWidth={1.75} aria-hidden /></span>
                  <h3 className="mt-4 text-lg font-bold leading-7">{title}</h3>
                  <p className="mt-2 text-ink-soft">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="oss-h" className="desk-wrap">
          <div className="grid gap-10 border-t border-line pb-16 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="min-w-0">
              <p className={LABEL}>Open source · MIT · bring your own key</p>
              <h2 id="oss-h" className={`mt-1 ${H2}`}>Add the persona your team actually sells to</h2>
              <p className="mt-3 max-w-[60ch] text-ink-soft">Build one with the wizard, export the pack file, and open a pull request. Packs are checked against the same schema the app uses.</p>
              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Link href="/library/new" className="btn-ghost desk-btn"><FileJson size={18} strokeWidth={1.75} aria-hidden /> Build a persona pack</Link>
                <a href="https://github.com/mastanley13/real-time-call-trainer-oss" className="desk-link" target="_blank" rel="noreferrer"><GitPullRequest size={18} strokeWidth={1.75} aria-hidden /> View on GitHub</a>
              </div>
            </div>
            <div className="min-w-0 self-start rounded-panel border border-line bg-sunken">
              <p className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold leading-5 text-ink">
                <KeyRound size={16} strokeWidth={1.75} aria-hidden /> Run it locally
              </p>
              <pre tabIndex={0} role="region" aria-label="Run it locally" className="overflow-x-auto p-5 font-mono text-sm leading-6 text-ink">{`git clone https://github.com/mastanley13/real-time-call-trainer-oss
cd real-time-call-trainer-oss && npm install
cp .env.example .env   # add OPENAI_API_KEY for the AI coach and voice
npm run dev`}</pre>
            </div>
          </div>
        </section>
      </div>

      <PublicFooter>
        <p>MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo</p>
      </PublicFooter>
    </>
  );
}

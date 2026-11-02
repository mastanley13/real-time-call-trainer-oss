import Link from "next/link";
import { ArrowRight, FileJson, GitPullRequest, KeyRound, LibraryBig, MessageSquareQuote, Radar } from "lucide-react";
import HeroDeck from "@/components/landing/HeroDeck";
import PublicFooter from "@/components/landing/PublicFooter";
import { LIBRARY } from "@/lib/personas";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Real-Time Call Trainer · Practice live calls with an AI coach",
  description:
    "Open-source voice practice for sales and service calls. A library of personas for every sales job, a live coach that whispers the next move, and rubric grading backed by transcript quotes.",
  path: "/",
});

const families = new Set(LIBRARY.map((s) => s.role)).size;

const STEPS = [
  { title: "Brief", body: "Pick a persona from the library. Read the goal, the objections to expect and the talk track." },
  { title: "Call", body: "Talk or type. The caller stays in character; a coach rail only you can see scores each turn and whispers the next move." },
  { title: "Debrief", body: "Every score cites your own words. Jump to the moment you lost points and retry the call from that turn." },
];

const MODELS = [
  { job: "Live coach", model: "gpt-4.1-mini (default)", note: "Per-turn cues and rubric estimate, as validated JSON" },
  { job: "Grading", model: "gpt-4.1-mini (default)", note: "Full-transcript rubric grade with verbatim evidence checks" },
  { job: "Persona wizard", model: "gpt-4.1-mini (default)", note: "Builds a persona, objections and rubric from your context" },
  { job: "Voice", model: "gpt-realtime-1.5 (default)", note: "OpenAI Realtime over WebRTC, the default when an OpenAI key is set. ElevenLabs Agents also supported" },
];

export default function Home() {
  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
          <div className="enter">
            <p className="eyebrow">Open source · MIT · bring your own key</p>
            <h1 className="mt-4 text-4xl font-bold leading-[1.05] sm:text-[56px]">
              Practice the call.<br /><span className="text-primary">Get coached while you talk.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Rehearse sales and service calls against AI personas from {families} sales jobs. A live coach scores every turn and
              cues you when an objection lands. The debrief backs every score with your own words.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/library" className="btn-primary btn-xl">Browse {LIBRARY.length} personas <ArrowRight size={18} aria-hidden /></Link>
              <Link href="/trainer" className="btn-ghost btn-xl">Start a practice call</Link>
            </div>
            <p className="mt-5 font-mono text-xs text-ink-muted">Works with no keys in demo mode · text or voice · runs on your own OpenAI-compatible key</p>
          </div>
          <div className="enter [animation-delay:120ms]"><HeroDeck /></div>
        </div>
      </section>

      <section className="page py-14 sm:py-16" aria-labelledby="how-h">
        <p className="eyebrow">How it works</p>
        <h2 id="how-h" className="mt-1 text-2xl font-bold sm:text-3xl">Brief, call, debrief. Then go again.</h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card relative">
              <span className="mono text-xs text-ink-muted">0{i + 1}</span>
              <h3 className="mt-2 text-lg font-bold">{s.title}</h3>
              <p className="mt-1.5 text-sm text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="models-h">
        <div className="page py-12">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Under the hood</p>
              <h2 id="models-h" className="mt-1 text-2xl font-bold">Which model does what</h2>
            </div>
            <p className="max-w-md text-sm text-ink-muted">Coaching, grades, wizard drafts and text-call replies show the model that produced them, or say when a rules-based fallback did. Point <span className="mono">LLM_BASE_URL</span> at any OpenAI-compatible API, with its own <span className="mono">LLM_API_KEY</span>, to swap models.</p>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MODELS.map((m) => (
              <div key={m.job} className="rounded-panel border border-line p-4">
                <p className="label !mb-1">{m.job}</p>
                <p className="chip-model">{m.model}</p>
                <p className="mt-2 text-sm text-ink-soft">{m.note}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="page py-14 sm:py-16" aria-labelledby="feat-h">
        <h2 id="feat-h" className="sr-only">Features</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { icon: LibraryBig, title: `${LIBRARY.length} personas, ${families} sales jobs`, body: "SDR cold calls to collections, filtered by role, industry, difficulty and the objections they throw. Each persona is a plain JSON pack." },
            { icon: Radar, title: "A live coach, not a script", body: "Live rubric estimate, talk-track progress and talk ratio, plus cues with a line you can use. Blind, Guided or Coached, your call." },
            { icon: MessageSquareQuote, title: "Evidence-backed debrief", body: "Scores cite verbatim quotes that are checked against the transcript. Click any quote to see the moment, then retry from that turn." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="card">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon size={20} aria-hidden /></span>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="deck" aria-labelledby="oss-h">
        <div className="page grid gap-8 py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <p className="eyebrow">Contribute</p>
            <h2 id="oss-h" className="mt-1 text-2xl font-bold sm:text-3xl">Add the persona your team actually sells to</h2>
            <p className="mt-3 max-w-lg text-ink-soft">Build one with the wizard, export the pack file, and open a pull request. Packs are checked against the same schema the app uses.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/library/new" className="btn-primary"><FileJson size={16} aria-hidden /> Build a persona pack</Link>
              <a href="https://github.com/mastanley13/real-time-call-trainer-oss" className="btn-ghost" target="_blank" rel="noreferrer"><GitPullRequest size={16} aria-hidden /> View on GitHub</a>
            </div>
          </div>
          <div className="panel overflow-x-auto p-4">
            <p className="label flex items-center gap-1.5"><KeyRound size={12} aria-hidden /> Run it locally</p>
            <pre className="font-mono text-[12.5px] leading-relaxed text-ink-soft">{`git clone https://github.com/mastanley13/real-time-call-trainer-oss
cd real-time-call-trainer-oss && npm install
cp .env.example .env   # add OPENAI_API_KEY for the AI coach and voice
DEMO_MODE=true npm run dev`}</pre>
          </div>
        </div>
      </section>

      <PublicFooter>
        <p>MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo</p>
      </PublicFooter>
    </div>
  );
}

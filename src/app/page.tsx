import Link from "next/link";
import { ArrowRight, ClipboardCheck, FileJson, GitPullRequest, IdCard, MessageSquare, Terminal } from "lucide-react";
import HeroDeck from "@/components/landing/HeroDeck";
import PublicFooter from "@/components/landing/PublicFooter";
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

/** Self-host docs: the model table and env vars moved here from the hosted home page. */
const SELF_HOST_DOCS = "https://github.com/mastanley13/real-time-call-trainer-oss#which-model-does-what";

export default function Home() {
  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
          <div className="enter">
            <p className="eyebrow">Free tier · no card · text or voice</p>
            <h1 className="mt-4 text-4xl font-bold leading-[1.05] sm:text-[56px]">
              Sales call practice, <span className="text-primary">no setup required</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Practice real sales calls against {LIBRARY.length} AI buyer personas. No API keys, no database, just sign up and start talking.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={registerHref({ src: "home_hero" })} className="btn-primary btn-xl">Start free <ArrowRight size={18} strokeWidth={1.75} aria-hidden /></Link>
              <Link href="/pricing" className="btn-ghost btn-xl">See pricing</Link>
            </div>
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

      {/* Continues How it works with no visible heading, so only bottom padding: one section gap, not two. */}
      <section className="page pb-14 sm:pb-16" aria-labelledby="feat-h">
        <h2 id="feat-h" className="sr-only">Features</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { icon: IdCard, title: `${LIBRARY.length} personas, ${families} sales jobs`, body: "SDR cold calls to collections, filtered by role, industry, difficulty and the objections they throw. Each persona is a plain JSON pack." },
            { icon: MessageSquare, title: "A live coach, not a script", body: "Live rubric estimate, talk-track progress and talk ratio, plus cues with a line you can use. Blind, Guided or Coached, your call." },
            { icon: ClipboardCheck, title: "Evidence-backed debrief", body: "Scores cite verbatim quotes that are checked against the transcript. Click any quote to see the moment, then retry from that turn." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="card">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon size={20} strokeWidth={1.75} aria-hidden /></span>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="deck" aria-labelledby="oss-h">
        <div className="page grid gap-8 py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <p className="eyebrow">Open source · MIT · bring your own key</p>
            <h2 id="oss-h" className="mt-1 text-2xl font-bold sm:text-3xl">Add the persona your team actually sells to</h2>
            <p className="mt-3 max-w-lg text-ink-soft">Build one with the wizard, export the pack file, and open a pull request. Packs are checked against the same schema the app uses.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/library/new" className="btn-primary"><FileJson size={16} strokeWidth={1.75} aria-hidden /> Build a persona pack</Link>
              <a href="https://github.com/mastanley13/real-time-call-trainer-oss" className="btn-ghost" target="_blank" rel="noreferrer"><GitPullRequest size={16} strokeWidth={1.75} aria-hidden /> View on GitHub</a>
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              <a href={SELF_HOST_DOCS} className="underline underline-offset-2 hover:text-ink" target="_blank" rel="noreferrer">Self-hosting</a>: which model does what, and how to swap it.
            </p>
          </div>
          <div className="panel overflow-x-auto p-4">
            <p className="label flex items-center gap-1.5"><Terminal size={12} strokeWidth={1.75} aria-hidden /> Run it locally</p>
            <pre className="font-mono text-[12.5px] leading-relaxed text-ink-soft">{`git clone https://github.com/mastanley13/real-time-call-trainer-oss
cd real-time-call-trainer-oss && npm install
cp .env.example .env   # add OPENAI_API_KEY for the AI coach and voice
npm run dev`}</pre>
          </div>
        </div>
      </section>

      <PublicFooter>
        <p>MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo</p>
      </PublicFooter>
    </div>
  );
}

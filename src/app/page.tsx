import Link from "next/link";
import { FileJson, GitPullRequest, LibraryBig, MessageSquareQuote, Radar, SquareTerminal } from "lucide-react";
import HeroDeck, { EXAMPLE_TURNS } from "@/components/landing/HeroDeck";
import LeaderboardSpotlight from "@/components/landing/LeaderboardSpotlight";
import PublicFooter from "@/components/landing/PublicFooter";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import "@/components/landing/landing-desk.css";
import { LIBRARY } from "@/lib/personas";
import { registerHref } from "@/lib/pricing";
import { jobFamilyLabel, type Scenario } from "@/lib/scenarios";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
  description:
    "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
  path: "/",
});

const families = new Set(LIBRARY.map((s) => s.role)).size;

/** One buyer from each of the first six job families, in library order: a fixed, varied sample for the showcase. */
const SHOWCASE: Scenario[] = (() => {
  const seen = new Set<string>();
  const out: Scenario[] = [];
  for (const s of LIBRARY) {
    if (seen.has(s.role)) continue;
    seen.add(s.role);
    out.push(s);
    if (out.length === 6) break;
  }
  return out;
})();

/** Lamps read like the call itself: not started, live, done. */
const STEPS = [
  { title: "Brief", lamp: "lamp-off", body: "Pick a persona from the library. Read the goal, the objections to expect and the talk track." },
  { title: "Call", lamp: "lamp-signal", body: "Talk or type. The caller stays in character; a coach rail only you can see scores each turn and whispers the next move." },
  { title: "Debrief", lamp: "lamp-ok", body: "Every score cites your own words. Jump to the moment you lost points and retry the call from that turn." },
];

// Provider names only, never model ids: operators pick models with LLM_MODEL and REALTIME_MODEL on the server.
const MODELS = [
  { job: "Live coach", engine: "Your chat model", note: "Per-turn cues and rubric estimate, as validated JSON" },
  { job: "Grading", engine: "Your chat model", note: "Full-transcript rubric grade with verbatim evidence checks" },
  { job: "Persona wizard", engine: "Your chat model", note: "Builds a persona, objections and rubric from your context" },
  { job: "Voice", engine: "OpenAI Realtime", note: "Over WebRTC, the default when an OpenAI key is set. ElevenLabs Agents also supported" },
];

const FEATURES = {
  buyers: { icon: LibraryBig, title: `${LIBRARY.length} AI buyers across ${families} sales jobs`, body: "From SDR cold calls to insurance renewals, portal leads and past-due calls. Filter by role, industry, difficulty and the objection they throw." },
  coach: { icon: Radar, title: "A live coach, not a script", body: "A live score on every turn, talk-track progress and a line your rep can use. Train Blind, Guided or Coached, so you choose how much help each rep gets." },
  debrief: { icon: MessageSquareQuote, title: "A debrief that quotes your rep's own words", body: "Every score cites what the rep actually said, checked against the transcript. Open a quote to see the moment, then retry the call from that turn." },
};

/** The water-heater talk track from the hero example: three steps done, the fee step live. */
const TALK_TRACK = ["Greet", "Urgency", "Contact", "Diagnose", "Fee and window", "Confirm"];
const TALK_TRACK_LIVE = 4;
const REP_QUOTE = EXAMPLE_TURNS.find((t) => t.role === "rep");

const H2 = "font-heading text-2xl font-bold leading-tight sm:text-[28px]";
const SECTION = "border-t border-line py-14 md:py-20";
const COL_HEAD = "px-5 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted";

function FeatureHead({ icon: Icon, title, body }: (typeof FEATURES)[keyof typeof FEATURES]) {
  return (
    <>
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-sunken text-primary">
        <Icon size={20} strokeWidth={1.75} aria-hidden />
      </span>
      <h3 className="mt-4 text-lg font-bold leading-7">{title}</h3>
      <p className="mt-2 max-w-[60ch] text-ink-soft">{body}</p>
    </>
  );
}

/**
 * Home page on the Flight Deck system. Static and server-rendered: no client code, so nothing here can ask for the
 * microphone. The .landing-desk wrapper scopes the content column, control size and focus ring (landing-desk.css); the
 * footer stays outside it so the shared chrome looks the same as on every other page.
 */
export default function Home() {
  return (
    <>
      <div className="landing-desk">
        <section aria-labelledby="hero-h" className="desk-wrap">
          <div className="grid items-center gap-10 py-10 md:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
            <div className="flex min-w-0 flex-col gap-6">
              <p className="chip w-fit gap-2 bg-surface py-1"><span className="lamp lamp-ok" aria-hidden />Free tier · no card · text or voice</p>
              <h1 id="hero-h" className="max-w-[20ch] text-[36px] font-bold leading-[1.08] sm:text-[44px] lg:text-[54px] lg:leading-[1.05]">
                Know which reps are ready before they&apos;re on a live call.
              </h1>
              <p className="max-w-[58ch] text-lg leading-7 text-ink-soft">
                {`Your reps practice against ${LIBRARY.length} AI buyers who push back. You read a graded debrief that quotes their own words, so you can see who is ready and what to coach next. Free to start, no card.`}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Link href={registerHref({ src: "home_hero" })} className="btn-primary desk-btn">Start free, no card</Link>
                <Link href="/pricing" className="btn-ghost desk-btn">See pricing</Link>
              </div>
              <p className="max-w-[60ch] border-l-2 border-line pl-3 text-sm leading-6 text-ink-soft">
                {"Managing 3 or more reps? Team adds a manager view and assignments: $59 a seat a month, 3-seat minimum. "}
                <Link href="/register?src=home_hero&plan=team&interval=month" className="rounded font-semibold text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">Start a Team</Link>
              </p>
            </div>
            <HeroDeck />
          </div>
        </section>

        <LeaderboardSpotlight />

        <section aria-labelledby="how-h" className="desk-wrap">
          <div className={SECTION}>
            <p className="eyebrow">How it works</p>
            <h2 id="how-h" className={`mt-2 ${H2}`}>Brief, call, debrief. Then go again.</h2>
            <ol role="list" className="desk-plan mt-10 grid list-none gap-6 md:grid-cols-3 md:gap-10">
              {STEPS.map((s) => (
                <li key={s.title} className="grid min-w-0 grid-cols-[8px_minmax(0,1fr)] gap-x-4 md:block">
                  <span className={`lamp ${s.lamp} mt-2 md:mt-0 md:block`} aria-hidden />
                  <div className="min-w-0 md:mt-5">
                    <h3 className="text-base font-semibold leading-6">{s.title}</h3>
                    <p className="mt-1.5 max-w-[48ch] text-ink-soft">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="models-h" className="desk-wrap">
          <div className={SECTION}>
            <div className="grid gap-x-16 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-end">
              <div className="min-w-0">
                <p className="eyebrow">Under the hood</p>
                <h2 id="models-h" className={`mt-2 ${H2}`}>What runs each job</h2>
              </div>
              <p className="max-w-[62ch] text-sm leading-6 text-ink-soft">Coaching, grades, wizard drafts and text-call replies say whether AI produced them or a rules-based fallback did. Point <span className="mono">LLM_BASE_URL</span> at any OpenAI-compatible API, with its own <span className="mono">LLM_API_KEY</span>, and set <span className="mono">LLM_MODEL</span> to swap models.</p>
            </div>
            <div className="panel mt-10 overflow-hidden">
              <table role="table" className="w-full text-left text-sm max-md:block">
                <caption className="sr-only">Which engine runs each job</caption>
                <thead role="rowgroup" className="bg-sunken max-md:sr-only">
                  <tr role="row">
                    <th role="columnheader" scope="col" className={`${COL_HEAD} md:w-[22%]`}>Job</th>
                    <th role="columnheader" scope="col" className={`${COL_HEAD} md:w-[26%]`}>Engine</th>
                    <th role="columnheader" scope="col" className={COL_HEAD}>What it does</th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className="max-md:block">
                  {MODELS.map((m) => (
                    <tr role="row" key={m.job} className="border-t border-line first:border-t-0 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1.5 max-md:px-5 max-md:py-4 md:first:border-t">
                      <th role="rowheader" scope="row" className="font-semibold text-ink md:px-5 md:py-4">{m.job}</th>
                      <td role="cell" className="md:px-5 md:py-4">
                        <span className="chip-model"><span className="lamp lamp-ok !h-1.5 !w-1.5" aria-hidden />{m.engine}</span>
                      </td>
                      <td role="cell" className="text-ink-soft max-md:col-span-2 md:px-5 md:py-4">{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section aria-labelledby="feat-h" className="desk-wrap">
          <div className="pb-14 md:pb-20">
            <h2 id="feat-h" className="sr-only">Features</h2>
            <ul role="list" className="grid list-none gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto] lg:gap-6">
              <li className="panel min-w-0 p-5 md:p-7 lg:row-span-2">
                <FeatureHead {...FEATURES.buyers} />
                <ul role="list" aria-label="A sample of the library" className="mt-6 grid list-none gap-2 sm:grid-cols-2">
                  {SHOWCASE.map((s) => (
                    <li key={s.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-line bg-sunken/60 px-3 py-2.5">
                      <PersonaAvatar scenario={s} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{s.aiPersona.name}</p>
                        <p className="truncate text-xs text-ink-muted">{jobFamilyLabel(s.role)}</p>
                      </div>
                      <DifficultyBars level={s.difficulty} showLabel={false} />
                    </li>
                  ))}
                </ul>
                <Link href="/library" className="btn-quiet mt-4 -ml-2 !px-2 text-primary">Browse the library</Link>
              </li>

              <li className="panel min-w-0 p-5 md:p-7">
                <FeatureHead {...FEATURES.coach} />
                <div className="mt-5 rounded-lg border border-line bg-sunken/60 p-4" aria-hidden="true">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">Talk track</p>
                    <p className="font-mono text-[11px] text-ink-soft">{TALK_TRACK_LIVE + 1} of {TALK_TRACK.length}</p>
                  </div>
                  <div className="mt-2 flex gap-1">
                    {TALK_TRACK.map((step, i) => (
                      <span key={step} className="desk-seg" data-state={i < TALK_TRACK_LIVE ? "done" : i === TALK_TRACK_LIVE ? "live" : "next"} />
                    ))}
                  </div>
                  <p className="mt-3 text-[13px] text-ink-soft"><span className="font-semibold text-ink">Next:</span> {TALK_TRACK[TALK_TRACK_LIVE].toLowerCase()}. Say the visit fee, then offer a window.</p>
                </div>
              </li>

              <li className="panel min-w-0 p-5 md:p-7">
                <FeatureHead {...FEATURES.debrief} />
                <div className="mt-5 rounded-lg border border-line bg-sunken/60 p-4" aria-hidden="true">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[13px] font-semibold text-ink">Discovery questions</p>
                    <span className="lamp lamp-ok" />
                  </div>
                  <div className="tape mt-2"><span className="bg-ok" style={{ width: "80%" }} /></div>
                  {REP_QUOTE && (
                    <p className="quote mt-3 !bg-surface !text-[13px]">
                      <span className="mr-2 font-mono text-[11px] text-ink-muted">T2</span>&ldquo;{REP_QUOTE.text}&rdquo;
                    </p>
                  )}
                </div>
              </li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="oss-h" className="desk-wrap">
          <div className={`grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16 ${SECTION}`}>
            <div className="min-w-0">
              <p className="eyebrow">Open source · MIT · bring your own key</p>
              <h2 id="oss-h" className={`mt-2 ${H2}`}>Add the persona your team actually sells to</h2>
              <p className="mt-3 max-w-[60ch] text-ink-soft">Build one with the wizard, export the pack file, and open a pull request. Packs are checked against the same schema the app uses.</p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Link href="/library/new" className="btn-ghost desk-btn"><FileJson size={18} strokeWidth={1.75} aria-hidden /> Build a persona pack</Link>
                <a href="https://github.com/mastanley13/real-time-call-trainer-oss" className="btn-quiet desk-btn" target="_blank" rel="noreferrer"><GitPullRequest size={18} strokeWidth={1.75} aria-hidden /> View on GitHub</a>
              </div>
            </div>
            <div className="deck min-w-0 self-start overflow-hidden rounded-panel border border-line shadow-pop">
              <p className="flex items-center gap-2 border-b border-line bg-surface px-5 py-3 text-sm font-semibold leading-5 text-ink">
                <SquareTerminal size={16} strokeWidth={1.75} className="text-primary" aria-hidden /> Run it locally
              </p>
              <pre tabIndex={0} role="region" aria-label="Run it locally" className="scroll-thin overflow-x-auto p-5 font-mono text-[13px] leading-6 text-ink">{`git clone https://github.com/mastanley13/real-time-call-trainer-oss
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

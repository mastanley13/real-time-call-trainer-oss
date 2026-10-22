import Link from "next/link";
import { Mic, ListChecks, MessageSquareQuote, SlidersHorizontal, ArrowRight } from "lucide-react";

const features = [
  { icon: Mic, title: "Talk to a realistic AI caller", body: "Voice conversations powered by ElevenLabs Agents. The persona stays in character and never coaches you mid-call." },
  { icon: SlidersHorizontal, title: "Scenarios you can edit", body: "Talk tracks, personas, goals and weighted rubrics are plain config. Duplicate a built-in and make it yours." },
  { icon: ListChecks, title: "Rubric-based grading", body: "Every criterion gets its own score, so you see exactly where a call won or lost points." },
  { icon: MessageSquareQuote, title: "Evidence from your own words", body: "Each score cites direct transcript quotes. No vague feedback, just what you actually said." },
];

export default function Home() {
  return (
    <div>
      <section className="border-b border-line bg-gradient-to-b from-white to-background">
        <div className="page grid gap-10 py-14 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="badge bg-accent-soft text-ink">Open source · MIT</span>
            <h1 className="mt-4 text-4xl font-bold leading-tight sm:text-5xl">
              Practice the call <span className="text-primary">before</span> it counts.
            </h1>
            <p className="mt-4 max-w-xl text-lg text-ink-soft">
              Real-Time Call Trainer lets reps rehearse sales and service calls against an AI persona, then
              debrief with rubric scores backed by transcript quotes.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/trainer" className="btn-primary">Start a practice call <ArrowRight size={16} /></Link>
              <Link href="/trainer/scenarios" className="btn-ghost">Browse scenarios</Link>
            </div>
          </div>
          <div className="card bg-ink text-white">
            <p className="font-heading text-sm text-accent">Example debrief</p>
            <div className="mt-4 space-y-3 text-sm">
              {[["Discovery questions", 82], ["Pricing transparency", 64], ["Booking & next steps", 91]].map(([n, v]) => (
                <div key={n as string}>
                  <div className="flex justify-between"><span>{n}</span><span>{v}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-white/10"><div className="h-2 rounded-full bg-accent" style={{ width: `${v}%` }} /></div>
                </div>
              ))}
            </div>
            <blockquote className="mt-5 border-l-2 border-accent pl-3 text-sm text-slate-300">
              “Before I give you a time, the diagnostic visit is $89, applied to the repair.”
              <footer className="mt-1 text-xs text-slate-400">Evidence · Pricing transparency</footer>
            </blockquote>
          </div>
        </div>
      </section>

      <section className="page">
        <h2 className="text-2xl font-bold sm:text-3xl">Built for deliberate practice</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><Icon size={20} aria-hidden /></span>
              <h3 className="mt-4 text-base font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-sm text-ink-muted">
        MIT licensed · by Mykel Stanley · originally based on OpenAI’s openai-realtime-agents demo
      </footer>
    </div>
  );
}

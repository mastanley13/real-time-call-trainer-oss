import Link from "next/link";
import CallOrb from "@/components/CallOrb";
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
      <section className="border-b border-line bg-[radial-gradient(70%_60%_at_80%_0%,#DBEAFE_0%,transparent_70%)]">
        <div className="page grid gap-12 py-14 sm:py-20 lg:grid-cols-2 lg:items-center">
          <div className="enter">
            <span className="badge bg-accent-soft text-accent-darker">Open source · MIT</span>
            <h1 className="mt-4 text-4xl font-bold leading-[1.1] sm:text-5xl">
              Practice the call <span className="text-primary">before</span> it counts.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Real-Time Call Trainer lets reps rehearse sales and service calls against an AI persona, then
              debrief with rubric scores backed by transcript quotes.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/trainer" className="btn-primary btn-pill btn-xl">Start a practice call <ArrowRight size={18} /></Link>
              <Link href="/trainer/scenarios" className="btn-ghost btn-pill btn-xl">Browse scenarios</Link>
            </div>
          </div>
          <div className="enter relative [animation-delay:120ms]">
            <div className="card relative overflow-hidden !p-0 shadow-pop">
              <div className="flex items-center gap-4 border-b border-line bg-gradient-to-b from-primary-soft/60 to-white p-5">
                <CallOrb state="listening" manual={{ input: 0.3, output: 0 }} className="h-16 w-16 shrink-0" />
                <div>
                  <p className="font-heading text-sm font-bold">Dana · Homeowner</p>
                  <p className="text-xs text-ink-muted">Listening…</p>
                </div>
              </div>
              <div className="space-y-3 p-5 text-sm">
                <p className="max-w-[80%] rounded-2xl rounded-bl-md bg-slate-100 px-4 py-2.5">Hi, my AC stopped cooling. How much will this cost?</p>
                <p className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-white">Before I give you a time, the diagnostic visit is $89, applied to the repair.</p>
              </div>
              <div className="space-y-3 border-t border-line bg-ink p-5 text-sm text-white">
                <p className="font-heading text-xs font-semibold uppercase tracking-wider text-accent">Example debrief</p>
                {[["Discovery questions", 82], ["Pricing transparency", 64], ["Booking & next steps", 91]].map(([n, v]) => (
                  <div key={n as string}>
                    <div className="flex justify-between"><span>{n}</span><span className="font-semibold">{v}</span></div>
                    <div className="mt-1.5 h-2 rounded-full bg-white/10"><div className="h-2 rounded-full bg-accent" style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="page py-14 sm:py-16">
        <p className="eyebrow">Why it works</p>
        <h2 className="mt-1 text-2xl font-bold sm:text-3xl">Built for deliberate practice</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="card card-hover">
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

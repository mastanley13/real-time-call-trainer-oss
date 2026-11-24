import Link from "next/link";
import { Check, ShieldAlert, Target } from "lucide-react";
import PricingSummary from "@/components/landing/PricingSummary";
import PublicFooter from "@/components/landing/PublicFooter";
import FaqList from "@/components/ui/FaqList";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import { CLOSING, PARTNER_RULES, type Landing } from "@/lib/landing";
import { LIBRARY } from "@/lib/personas";
import { registerHref } from "@/lib/pricing";
import { CALL_TYPE_LABELS, type Scenario } from "@/lib/scenarios";

/** The library persona with this display name, if there is one. Landing copy names personas; tests keep the names real. */
export const scenarioByName = (name: string): Scenario | undefined => LIBRARY.find((s) => s.aiPersona.name === name);

/** Lamps along a flight plan: the first step is not started, the last is done, the ones between are live. */
export const planLamp = (i: number, n: number) => (i === 0 ? "lamp-off" : i === n - 1 ? "lamp-ok" : "lamp-signal");

/**
 * A static slice of a call with one library persona: who picks up, their opening line, the goal, and the first objection
 * to expect with its prep answer, styled like the live deck and the coach cue. Server-safe; no score, no client code.
 * Used in the dark hero on /for/* and /try/*.
 */
export function SessionPreview({ scenario, label = "Example session" }: { scenario: Scenario; label?: string }) {
  const objection = scenario.objections[0];
  return (
    <div className="panel min-w-0 overflow-hidden shadow-pop" aria-label={`${label} with ${scenario.aiPersona.name}`} role="group">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <PersonaAvatar scenario={scenario} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-sm font-bold text-ink">{scenario.aiPersona.name}</p>
          <p className="truncate text-xs text-ink-muted">{scenario.title}</p>
        </div>
        <span className="chip-model shrink-0"><span className="lamp lamp-ok !h-1.5 !w-1.5" aria-hidden />{label}</span>
      </div>

      <div className="flex items-start gap-2 border-b border-line px-4 py-2.5 text-[13px] sm:px-5">
        <Target size={14} strokeWidth={1.75} className="mt-[3px] shrink-0 text-primary" aria-hidden />
        <p className="line-clamp-2 min-w-0 flex-1"><span className="font-semibold text-ink">Goal:</span> <span className="text-ink-soft">{scenario.traineeGoal}</span></p>
      </div>

      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 px-4 py-4 sm:grid-cols-[52px_minmax(0,1fr)] sm:px-5">
        <p className="pt-0.5 font-mono text-[11px] leading-tight text-ink-muted" aria-hidden>T1<br />00:00</p>
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-medium uppercase tracking-wide text-ink-muted">{scenario.aiPersona.name.split(" ")[0]}</p>
          <p className="mt-0.5 text-[15px] leading-relaxed text-ink-soft">&ldquo;{scenario.aiPersona.openingLine}&rdquo;</p>
        </div>
      </div>

      {objection && (
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <div className="rounded-panel border-l-2 border-alert/60 bg-sunken p-3 text-alert shadow-inner-top">
            <div className="flex items-start gap-2">
              <ShieldAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em]">Objection to expect</p>
                <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">&ldquo;{objection.line}&rdquo;</p>
              </div>
            </div>
            {objection.prepAnswer && (
              <div className="mt-2 rounded-md border border-dashed border-line bg-surface p-2.5">
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">Suggested line</p>
                <p className="mt-0.5 line-clamp-3 text-[13px] font-medium text-ink">&ldquo;{objection.prepAnswer}&rdquo;</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line bg-sunken/60 px-4 py-2.5 sm:px-5">
        <DifficultyBars level={scenario.difficulty} />
        <span className="font-mono text-[11px] text-ink-muted">{CALL_TYPE_LABELS[scenario.callType]}, about {scenario.durationMin} min</span>
      </div>
    </div>
  );
}

const H2 = "text-2xl font-bold sm:text-[28px]";

/** Shared layout for the /for/* vertical landing pages. Static; copy comes from src/lib/landing.ts. */
export default function LandingPage({ l, billingEnabled }: { l: Landing; billingEnabled: boolean }) {
  const partner = l.slug === "coaches";
  const external = l.primaryHref.startsWith("mailto:");
  const preview = l.personas.map((p) => scenarioByName(p.name)).find((s): s is Scenario => !!s);
  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page grid gap-10 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center lg:gap-14">
          <div className="min-w-0">
            <p className="eyebrow">{l.audience}</p>
            <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] sm:text-[52px]">{l.hero}</h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">{l.subhead}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {external
                ? <a href={l.primaryHref} className="btn-primary btn-xl">{l.primaryLabel}</a>
                : <Link href={l.primaryHref} className="btn-primary btn-xl">{l.primaryLabel}</Link>}
              <Link href={l.secondary.href} className="btn-ghost btn-xl">{l.secondary.label}</Link>
            </div>
          </div>
          {preview && <SessionPreview scenario={preview} />}
        </div>
      </section>

      <section className="page py-12 sm:py-16" aria-labelledby="pain-h">
        <h2 id="pain-h" className="sr-only">Problems we hear about</h2>
        <div className="grid gap-4 md:grid-cols-3 lg:gap-6">
          {l.pains.map((p) => (
            <div key={p.title} className="panel min-w-0 p-5 sm:p-6">
              <span className="lamp lamp-caution" aria-hidden />
              <h3 className="mt-4 text-base font-semibold leading-6">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="how-h">
        <div className="page py-12 sm:py-16">
          <p className="eyebrow">How it works</p>
          <h2 id="how-h" className={`mt-2 ${H2}`}>{partner ? "From application to practice" : "Brief, call, debrief. Then go again."}</h2>
          <ol className={`mt-10 grid gap-x-8 gap-y-6 ${l.steps.length === 3 ? "md:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4"}`}>
            {l.steps.map((s, i) => (
              <li key={s.title} className="grid min-w-0 grid-cols-[8px_minmax(0,1fr)] gap-x-4 sm:block">
                <div className="flex items-center gap-3 pt-2 sm:pt-0" aria-hidden>
                  <span className={`lamp ${planLamp(i, l.steps.length)}`} />
                  {i < l.steps.length - 1 && <span className="hidden h-px flex-1 bg-line sm:block" />}
                </div>
                <div className="min-w-0 sm:mt-5">
                  <h3 className="text-base font-bold">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="page py-12 sm:py-16" aria-labelledby="personas-h">
        <p className="eyebrow">Personas</p>
        <h2 id="personas-h" className={`mt-2 ${H2}`}>{partner ? "A taste of the library" : "Buyers you can practice on today"}</h2>
        <ul className="mt-8 grid gap-4 md:grid-cols-3 lg:gap-6">
          {l.personas.map((p) => {
            const s = scenarioByName(p.name);
            return (
              <li key={p.name} className="panel flex min-w-0 flex-col p-5">
                <div className="flex items-center gap-3">
                  {s && <PersonaAvatar scenario={s} size={40} />}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-base font-semibold">{p.name}</h3>
                    {s && <p className="truncate text-xs text-ink-muted">{s.title}</p>}
                  </div>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-soft">{p.blurb}</p>
                {(p.tag || s) && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                    {p.tag ? <span className="chip">{p.tag}</span> : <span />}
                    {s && <DifficultyBars level={s.difficulty} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {l.comingSoon && (
          <div className="panel mt-4 p-5 lg:mt-6">
            <p className="flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              <span className="lamp lamp-off" aria-hidden />{l.comingSoon.label}
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-ink-soft">
              {l.comingSoon.names.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        )}
      </section>

      {partner && (
        <section className="border-y border-line bg-surface" aria-labelledby="rules-h">
          <div className="page grid gap-6 py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
            <h2 id="rules-h" className={H2}>Partner rules</h2>
            <ul className="panel divide-y divide-line">
              {PARTNER_RULES.map((r) => (
                <li key={r} className="flex gap-3 px-5 py-4 text-sm leading-relaxed text-ink-soft">
                  <Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <PricingSummary src={`for-${l.slug}`} seg={l.seg} billingEnabled={billingEnabled} />

      <section className="page grid gap-8 pb-12 sm:pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16" aria-labelledby="faq-h">
        <h2 id="faq-h" className={H2}>Questions</h2>
        <FaqList items={l.faq} className="min-w-0" />
      </section>

      <section className="deck border-t border-line">
        <div className="page flex flex-col items-start gap-6 py-14 sm:py-16 lg:flex-row lg:items-center lg:justify-between">
          <p className="max-w-2xl font-heading text-2xl font-bold leading-snug text-ink sm:text-3xl">{CLOSING}</p>
          <Link href={partner ? registerHref({ src: "coaches" }) : l.primaryHref} className="btn-primary btn-xl shrink-0">Start free, no card</Link>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

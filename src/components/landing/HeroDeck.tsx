import { ShieldAlert, Target } from "lucide-react";

/**
 * Landing hero example: three turns from the water-heater scenario and the one coach cue they triggered, drawn as a slice
 * of the live call deck. The .deck class keeps it a dark instrument panel in daylight too.
 * Static and server-rendered: no client code, no score, no microphone. Clearly labeled as an example session.
 * One orchestrated reveal: the turns rise in order, then the cue slides in (motion-safe only).
 */

export type ExampleTurn = { speaker: string; role: "buyer" | "rep"; at: string; text: string; objection?: boolean };

export const EXAMPLE_PERSONA = { name: "Dana Whitfield", initials: "DW", context: "Inbound lead · water heater" };

export const EXAMPLE_GOAL = "Book a same-day visit and capture contact details.";

export const EXAMPLE_TURNS: ExampleTurn[] = [
  { speaker: "Dana", role: "buyer", at: "00:52", text: "It started this morning. There's a puddle by the base of the tank." },
  { speaker: "You", role: "rep", at: "01:02", text: "How old is the unit, and is the leak from the bottom of the tank or a pipe?" },
  { speaker: "Dana", role: "buyer", at: "01:14", text: "What does a visit cost? Nobody mentioned a fee.", objection: true },
];

export const EXAMPLE_CUE = {
  label: "Objection",
  turn: 3,
  title: "Price objection",
  message: "Name the fee before you offer a time slot.",
  suggestedLine: "Fair question. The diagnostic visit is $89, and it's credited toward the repair if you go ahead.",
};

const TURN_DELAY_MS = 140;

export default function HeroDeck() {
  return (
    <section aria-labelledby="example-h" className="deck min-w-0 overflow-hidden rounded-sheet border border-line shadow-pop">
      {/* Top bar, as on the live call */}
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-5">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken font-heading text-xs font-bold text-ink ring-2 ring-primary/40" aria-hidden>
          {EXAMPLE_PERSONA.initials}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="example-h" className="truncate font-heading text-sm font-bold sm:text-[15px]">
            <span className="sr-only">Example session with </span>{EXAMPLE_PERSONA.name}
          </h2>
          <p className="truncate text-xs text-ink-muted">{EXAMPLE_PERSONA.context}</p>
        </div>
        <span className="chip-model shrink-0" aria-hidden="true"><span className="lamp lamp-ok !h-1.5 !w-1.5" />Example session</span>
      </div>

      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] sm:px-5">
        <Target size={14} strokeWidth={1.75} className="shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1"><span className="font-semibold">Goal:</span> <span className="text-ink-soft">{EXAMPLE_GOAL}</span></p>
      </div>

      <ol role="list" aria-label="Transcript" className="flex list-none flex-col gap-1 px-2 py-3 sm:px-3">
        {EXAMPLE_TURNS.map((t, i) => {
          const me = t.role === "rep";
          return (
            <li key={t.at} style={{ animationDelay: `${120 + i * TURN_DELAY_MS}ms` }}
              className={`grid grid-cols-[44px_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2.5 motion-safe:animate-fade-up sm:grid-cols-[56px_minmax(0,1fr)] ${t.objection ? "bg-alert-soft/60 ring-1 ring-alert/40" : ""}`}>
              <p className="pt-0.5 font-mono text-[11px] leading-tight text-ink-muted" aria-hidden="true">T{i + 1}<br />{t.at}</p>
              <div className="min-w-0">
                <p className={`font-mono text-[11px] font-medium uppercase tracking-wide ${me ? "text-primary" : "text-ink-muted"}`}>
                  <span>{t.speaker}</span><span className="sr-only">, {t.role}, at {t.at}</span>
                </p>
                <p className={`mt-0.5 break-words text-[15px] leading-relaxed ${me ? "text-ink" : "text-ink-soft"}`}>{t.text}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-line bg-surface px-4 py-4 sm:px-5">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">Coach, only you see it</p>
        <div role="note" aria-label="Coach cue" style={{ animationDelay: `${180 + EXAMPLE_TURNS.length * TURN_DELAY_MS}ms` }}
          className="mt-2.5 rounded-panel border-l-2 border-alert/60 bg-sunken p-3 text-alert shadow-inner-top motion-safe:animate-cue-in">
          <div className="flex items-start gap-2">
            <ShieldAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em]">{EXAMPLE_CUE.label} · turn {EXAMPLE_CUE.turn}</p>
              <p className="mt-0.5 text-sm font-semibold text-ink">{EXAMPLE_CUE.title}</p>
            </div>
          </div>
          <p className="mt-2 text-[13px] text-ink-soft">{EXAMPLE_CUE.message}</p>
          <div className="mt-2 rounded-md border border-dashed border-line bg-surface p-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">Suggested line</p>
            <p className="mt-0.5 text-[13px] font-medium text-ink">&ldquo;{EXAMPLE_CUE.suggestedLine}&rdquo;</p>
          </div>
        </div>
      </div>
    </section>
  );
}

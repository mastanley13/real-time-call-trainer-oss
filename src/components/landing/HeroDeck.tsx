"use client";

import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS, talkTrackSteps } from "@/lib/scenarios";
import { CriteriaTapes, CueCard, Instruments } from "@/components/call/CopilotRail";
import type { LiveCue } from "@/components/call/useCoach";

const scenario = BUILT_IN_SCENARIOS[0];

/** A frozen moment from a real call (water-heater scenario), rendered with the same components as the live rail. */
const SAMPLE: CoachResult = {
  estimate: {
    overall: 58,
    criteria: [
      { id: "greeting", name: "Greeting & rapport", weight: 15, score: 86, confirmed: true },
      { id: "discovery", name: "Discovery questions", weight: 30, score: 72, confirmed: true },
      { id: "capture", name: "Information capture", weight: 20, score: 55, confirmed: true },
      { id: "fee", name: "Pricing transparency", weight: 15, score: 14, confirmed: false },
      { id: "close", name: "Booking & next steps", weight: 20, score: 10, confirmed: false },
    ],
  },
  steps: [true, true, true, true, false, false],
  cue: null,
  talkRatio: 0.46,
  source: "llm",
  model: "gpt-4.1-mini",
  latencyMs: 1300,
};
const CUE: LiveCue = {
  id: "demo", type: "objection", status: "active", triggerTurn: 7,
  title: "Price objection: answer it directly",
  message: "Name the fee before you offer a time slot.",
  heard: "What does a visit cost? Nobody mentioned a fee.",
  suggestedLine: "Fair question. The diagnostic visit is $89, and it's credited toward the repair.",
};
const LINES: [string, string][] = [
  ["Dana", "It started this morning. There's a puddle by the base of the tank."],
  ["You", "How old is the unit, and is the leak from the bottom of the tank or a pipe?"],
  ["Dana", "What does a visit cost? Nobody mentioned a fee."],
];

export default function HeroDeck() {
  const steps = talkTrackSteps(scenario.callScript);
  return (
    <div className="deck overflow-hidden rounded-sheet border border-line shadow-pop" aria-label="Example of the live coach during a call" role="img">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <span className="lamp lamp-ok" aria-hidden />
        <p className="font-heading text-sm font-bold">Dana Whitfield</p>
        <span className="hidden text-xs text-ink-muted sm:inline">Inbound lead · water heater</span>
        <span className="mono ml-auto text-sm font-semibold">01:14</span>
        <span className="rounded-md bg-alert px-2 py-1 text-[11px] font-semibold text-alert-on">End & grade</span>
      </div>
      {/* Inert on the inside, not the root: the root's role="img" label stays exposed while the
          real CueCard's buttons and aria-live region drop out of tab order and announcements. */}
      <div className="grid sm:grid-cols-[minmax(0,1fr)_250px]" inert>
        <ol className="space-y-3 p-4">
          {LINES.map(([who, text], i) => (
            <li key={i} className={`rounded-md p-2 ${i === 2 ? "bg-alert-soft/60 ring-1 ring-alert/40" : ""}`}>
              <p className={`font-mono text-[10px] uppercase tracking-wide ${who === "You" ? "text-primary" : "text-ink-muted"}`}>T{5 + i} · {who}</p>
              <p className={`mt-0.5 text-[13px] leading-snug ${who === "You" ? "text-ink" : "text-ink-soft"}`}>{text}</p>
              {who === "You" && <p className="mt-1 inline-block rounded bg-ok-soft px-1.5 py-0.5 font-mono text-[10px] text-ok">▲ Discovery questions +12</p>}
            </li>
          ))}
          <li className="pt-1"><CueCard cue={CUE} voice={false} onUse={() => {}} onDismiss={() => {}} compact /></li>
        </ol>
        <div className="hidden space-y-4 border-l border-line bg-surface p-4 sm:block">
          <Instruments result={SAMPLE} steps={steps} compact />
          <CriteriaTapes scenario={scenario} result={SAMPLE} />
        </div>
      </div>
    </div>
  );
}

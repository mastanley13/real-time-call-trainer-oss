"use client";

import { Check, CircleHelp, CornerDownLeft, Ear, Flag, ShieldAlert, X } from "lucide-react";
import { COACH_MODES, COACH_MODE_LABELS, CUE_LABELS, type CoachMode, type CoachResult, type CueType } from "@/lib/coach-types";
import { talkTrackSteps, type Scenario } from "@/lib/scenarios";
import type { LiveCue } from "./useCoach";

export const CUE_ICON: Record<CueType, typeof ShieldAlert> = { objection: ShieldAlert, next_question: CircleHelp, whisper: Ear, guardrail: Flag };
export const CUE_TONE: Record<CueType, string> = {
  objection: "text-alert border-alert/60",
  next_question: "text-signal border-signal/60",
  whisper: "text-ok border-ok/60",
  guardrail: "text-caution border-caution/60",
};

const scoreTone = (n: number) => (n >= 75 ? "text-ok" : n >= 45 ? "text-signal" : "text-caution");

/**
 * Keyboard model for a role="radiogroup" of buttons (WAI-ARIA radio pattern), also used for a
 * role="tablist": the group is one Tab stop (give the checked option tabIndex 0 and the rest -1),
 * and the arrow keys move to and select the next enabled option. Put the handler on the group element.
 */
export function radioKeys<T>(options: readonly T[], value: T, onChange: (v: T) => void, isDisabled: (v: T) => boolean = () => false) {
  return (e: React.KeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]');
    let i = Math.max(0, options.indexOf(value));
    for (let n = 0; n < options.length; n++) {
      i = (i + step + options.length) % options.length;
      if (isDisabled(options[i])) continue;
      onChange(options[i]);
      radios[i]?.focus();
      return;
    }
  };
}

/** Live estimate, talk track and talk ratio: the three instruments at the top of the rail. */
export function Instruments({ result, steps, compact = false }: { result: CoachResult | null; steps: string[]; compact?: boolean }) {
  const overall = result?.estimate.overall ?? 0;
  const done = result?.steps.filter(Boolean).length ?? 0;
  const ratio = Math.round((result?.talkRatio ?? 0) * 100);
  const ratioOk = ratio >= 35 && ratio <= 65;
  return (
    <div className={`grid grid-cols-3 ${compact ? "gap-3" : "gap-4"}`}>
      <div>
        <p className="label !mb-1">Live estimate</p>
        <p className={`mono font-semibold leading-none ${compact ? "text-2xl" : "text-[34px]"} ${result ? scoreTone(overall) : "text-ink-muted"}`}>{result ? overall : "--"}<span className="text-xs text-ink-muted">/100</span></p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-muted">not final</p>
      </div>
      <div>
        <p className="label !mb-1">Talk track</p>
        <p className={`mono font-semibold leading-none text-ink ${compact ? "text-2xl" : "text-[34px]"}`}>{done}<span className="text-xs text-ink-muted">/{steps.length}</span></p>
        <div className="mt-2 flex gap-0.5" aria-hidden>{steps.map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${result?.steps[i] ? "bg-ok" : "bg-line"}`} />)}</div>
      </div>
      <div>
        <p className="label !mb-1">You talk</p>
        <p className={`mono font-semibold leading-none ${compact ? "text-2xl" : "text-[34px]"} ${!result ? "text-ink-muted" : ratioOk ? "text-ink" : "text-caution"}`}>{result ? ratio : "--"}<span className="text-xs text-ink-muted">%</span></p>
        <div className="relative mt-2 h-1 rounded-full bg-line" aria-hidden>
          <span className="absolute inset-y-0 rounded-full bg-ok/40" style={{ left: "35%", width: "30%" }} />
          {result && <span className="absolute -top-1 h-3 w-0.5 rounded bg-ink" style={{ left: `${ratio}%` }} />}
        </div>
      </div>
    </div>
  );
}

/** Rubric tapes: hatched while provisional, solid once a transcript quote confirms the criterion. */
export function CriteriaTapes({ scenario, result }: { scenario: Scenario; result: CoachResult | null }) {
  const total = scenario.rubric.reduce((a, c) => a + c.weight, 0) || 1;
  const rows = result?.estimate.criteria ?? scenario.rubric.map((c) => ({ id: c.id, name: c.name, weight: (c.weight / total) * 100, score: 0, confirmed: false }));
  return (
    <ul className="space-y-2.5">
      {rows.map((c) => (
        <li key={c.id}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate">{c.name}</span>
            <span className="mono shrink-0 text-[11px] text-ink-muted">{Math.round(c.weight)}% · <span className={c.confirmed ? scoreTone(c.score) : ""}>{Math.round(c.score)}</span></span>
          </div>
          <div className="tape" role="meter" aria-label={`${c.name}: ${Math.round(c.score)} of 100, ${c.confirmed ? "confirmed by a quote" : "provisional"}`} aria-valuenow={Math.round(c.score)} aria-valuemin={0} aria-valuemax={100}>
            <span className={`${scoreTone(c.score)} ${c.confirmed ? "bg-current" : "hatched"}`} style={{ width: `${Math.max(2, c.score)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TalkTrack({ steps, result }: { steps: string[]; result: CoachResult | null }) {
  const current = result ? result.steps.findIndex((d) => !d) : 0;
  return (
    <ol className="space-y-1">
      {steps.map((s, i) => {
        const done = !!result?.steps[i];
        const now = i === current;
        return (
          <li key={i} className={`flex items-start gap-2.5 rounded-md px-1.5 py-1 text-[13px] ${now ? "bg-primary-soft/60" : ""}`}>
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${done ? "border-ok bg-ok text-background" : now ? "border-signal" : "border-line"}`} aria-hidden>
              {done && <Check size={11} strokeWidth={3} />}
            </span>
            <span className={`${done ? "text-ink-muted line-through decoration-line" : now ? "font-medium text-ink" : "text-ink-soft"}`}>{now && <span className="sr-only">Now: </span>}{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function CueCard({ cue, voice, onUse, onDismiss, compact = false }: { cue: LiveCue; voice: boolean; onUse: () => void; onDismiss: () => void; compact?: boolean }) {
  const Icon = CUE_ICON[cue.type];
  return (
    // Not a live region: a region mounted with its text already in it is usually not announced. Deck announces new cues.
    <article className={`animate-cue-in rounded-panel border-l-2 bg-sunken p-3 ${CUE_TONE[cue.type]} ${compact ? "" : "shadow-inner-top"}`}>
      <div className="flex items-start gap-2">
        <Icon size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em]">{CUE_LABELS[cue.type]} · turn {cue.triggerTurn}</p>
          <p className="mt-0.5 text-sm font-semibold text-ink">{cue.title}</p>
        </div>
        <button className="rounded p-1 text-ink-muted hover:bg-surface hover:text-ink" onClick={onDismiss} aria-label={`Dismiss cue: ${cue.title}`}><X size={14} aria-hidden /></button>
      </div>
      {cue.heard && <p className="mt-2 border-l border-line pl-2 text-[12.5px] italic text-ink-soft"><span className="not-italic font-mono text-[10px] uppercase text-ink-muted">Heard </span>&ldquo;{cue.heard}&rdquo;</p>}
      {cue.message && <p className="mt-2 text-[13px] text-ink-soft">{cue.message}</p>}
      {cue.suggestedLine && (
        <div className="mt-2 rounded-md border border-dashed border-line bg-surface p-2.5">
          <p className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">{voice ? "Say something like" : "Suggested line"}</p>
          <p className="mt-0.5 text-[13px] font-medium text-ink">&ldquo;{cue.suggestedLine}&rdquo;</p>
        </div>
      )}
      {cue.suggestedLine && !voice && (
        <div className="mt-2.5 flex gap-2">
          <button type="button" className="btn-primary btn-sm" onClick={onUse}><CornerDownLeft size={13} aria-hidden /> Use line</button>
          <button className="btn-quiet btn-sm" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
    </article>
  );
}

export function ModeDial({ mode, onChange, disabled = false }: { mode: CoachMode; onChange: (m: CoachMode) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-sunken p-1" role="radiogroup" aria-label="Coach mode" onKeyDown={disabled ? undefined : radioKeys(COACH_MODES, mode, onChange)}>
      {COACH_MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} disabled={disabled} onClick={() => onChange(m)}
          className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${mode === m ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
          {COACH_MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

/** The full copilot rail beside the transcript. */
export default function CopilotRail({ scenario, result, cues, mode, onModeChange, voice, onUseLine, onDismiss, coachLabel, error }: {
  scenario: Scenario;
  result: CoachResult | null;
  cues: LiveCue[];
  mode: CoachMode;
  onModeChange: (m: CoachMode) => void;
  voice: boolean;
  onUseLine: (cue: LiveCue) => void;
  onDismiss: (id: string) => void;
  coachLabel: string;
  error?: string;
}) {
  const steps = talkTrackSteps(scenario.callScript);
  const active = cues.filter((c) => c.status === "active");
  const earlier = cues.filter((c) => c.status !== "active").slice(0, 4);
  return (
    <aside className="flex min-h-0 flex-col border-line bg-surface lg:border-l" aria-label="Coach">
      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {mode === "blind" ? (
          <div className="rounded-panel border border-dashed border-line p-4 text-sm text-ink-soft">
            <p className="font-semibold text-ink">Blind mode</p>
            <p className="mt-1">No live help this call. You get the full debrief when you end it. Switch to Guided or Coached below at any time.</p>
          </div>
        ) : (
          <>
            <section aria-label="Live instruments"><Instruments result={result} steps={steps} /></section>
            <section aria-labelledby="rail-rubric">
              <h2 id="rail-rubric" className="label">Rubric <span className="normal-case tracking-normal">· same weights as your final grade</span></h2>
              <CriteriaTapes scenario={scenario} result={result} />
            </section>
            <section aria-labelledby="rail-track">
              <h2 id="rail-track" className="label">Talk track</h2>
              <TalkTrack steps={steps} result={result} />
            </section>
            {mode === "coached" && (
              <section aria-labelledby="rail-cues">
                <h2 id="rail-cues" className="label">Coach cues <span className="normal-case tracking-normal">· only you see these</span></h2>
                {active.length ? (
                  <div className="space-y-2.5">{active.map((c) => <CueCard key={c.id} cue={c} voice={voice} onUse={() => onUseLine(c)} onDismiss={() => onDismiss(c.id)} />)}</div>
                ) : (
                  <p className="rounded-panel border border-dashed border-line p-3 text-[13px] text-ink-muted">Cues appear here when an objection lands, a talk-track step is due, or you drift. The caller never hears them.</p>
                )}
                {earlier.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-line pt-3">
                    {earlier.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
                        <span className="min-w-0 truncate">{CUE_LABELS[c.type]} · {c.title}</span>
                        <span className={`mono shrink-0 ${c.status === "used" ? "text-ok" : ""}`}>{c.status === "used" ? "Used" : "Dismissed"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
        {error && <p className="rounded-md bg-caution-soft p-2 text-[12px] text-ink" role="status">{error}</p>}
      </div>
      <div className="space-y-2.5 border-t border-line p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="chip-model"><span className={`lamp ${mode === "blind" ? "lamp-off" : "lamp-ok"} !h-1.5 !w-1.5`} aria-hidden />{coachLabel}</span>
          <span className="font-mono text-[10px] uppercase text-ink-muted">Coach mode</span>
        </div>
        <ModeDial mode={mode} onChange={onModeChange} />
      </div>
    </aside>
  );
}

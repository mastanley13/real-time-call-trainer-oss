"use client";

import { Check, CircleHelp, Ear, Flag, ShieldAlert } from "lucide-react";
import { COACH_MODES, COACH_MODE_LABELS, CUE_LABELS, type CoachMode, type CoachResult, type CueType } from "@/lib/coach-types";
import type { Scenario } from "@/lib/scenarios";
import { CUE_NOTE } from "./callCopy";
import type { LiveCue } from "./useCoach";

/**
 * The coach side of the call screen ("Buyer and brief"): the buyer brief, exactly one next move, talk-track progress,
 * earlier cues and the coach mode. No live score: the overall estimate and the rubric meters are not drawn during a
 * call, so nothing competes with the buyer. The final, evidence-backed grade is on the debrief.
 */

/** Cue type icons for the debrief's moment strip. The live call draws no cue icons. */
export const CUE_ICON: Record<CueType, typeof ShieldAlert> = { objection: ShieldAlert, next_question: CircleHelp, whisper: Ear, guardrail: Flag };

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

export function TalkTrack({ steps, result }: { steps: string[]; result: CoachResult | null }) {
  const current = result ? result.steps.findIndex((d) => !d) : 0;
  return (
    <ol className="space-y-1">
      {steps.map((s, i) => {
        const done = !!result?.steps[i];
        const now = i === current;
        return (
          <li key={i} className={`flex items-start gap-2.5 rounded-control px-1.5 py-1 text-sm ${now ? "bg-primary-soft/60" : ""}`}>
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${done ? "border-ok bg-ok text-background" : now ? "border-primary" : "border-line"}`} aria-hidden>
              {done && <Check size={11} strokeWidth={3} />}
            </span>
            <span className={`${done ? "text-ink-soft line-through decoration-line" : now ? "font-medium text-ink" : "text-ink-soft"}`}>
              {done && <span className="sr-only">Done: </span>}{now && <span className="sr-only">Now: </span>}{s}
            </span>
          </li>
        );
      })}
    </ol>
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

/** Goal and expected objections. Prep answers stay on the briefing: during the call, help comes as one next move. */
export function BuyerBrief({ scenario, idPrefix, titleHidden = false }: { scenario: Scenario; idPrefix: string; titleHidden?: boolean }) {
  const id = `${idPrefix}-brief`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={titleHidden ? "sr-only" : "text-xl font-bold"}>Buyer brief</h2>
      <p className={`${titleHidden ? "" : "mt-1"} text-sm text-ink-soft`}>{scenario.aiPersona.role}</p>
      <dl className="mt-3 divide-y divide-line border-t border-line text-sm">
        <div className="py-3">
          <dt className="text-ink-soft">Your goal</dt>
          <dd className="mt-1 font-semibold text-ink">{scenario.traineeGoal}</dd>
        </div>
        {scenario.objections.length > 0 && (
          <div className="py-3">
            <dt className="text-ink-soft">Expect these objections</dt>
            <dd className="mt-1">
              <ul className="space-y-1.5">
                {scenario.objections.map((o, i) => <li key={i} className="break-words font-medium text-ink">&ldquo;{o.line}&rdquo;</li>)}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/**
 * Exactly one next move. In Coached mode it holds the newest active cue, or a quiet empty state on wide screens (on
 * phones the empty state is hidden so the transcript keeps the room). It is not a live region and never takes focus;
 * the Deck announces new cues through one polite region.
 * `compact`: the phone brief is open, so below 1024 px the cue shrinks to its heading and title on one line (the
 * full card, with Use line and Hide cue, comes back when the brief closes). Wide screens always show the full card.
 */
export function NextMove({ cue, voice, onUse, onDismiss, compact = false }: { cue: LiveCue | undefined; voice: boolean; onUse: () => void; onDismiss: () => void; compact?: boolean }) {
  const slim = compact && !!cue;
  return (
    <section aria-labelledby="next-move-h" data-next-move="" className={`rounded-r-panel border-l-4 border-primary bg-sunken ${slim ? "px-3 py-2 lg:p-4" : "p-4"} ${cue ? "motion-safe:animate-cue-in" : "hidden lg:block"}`}>
      <h2 id="next-move-h" className="text-sm font-semibold text-ink">
        Next move{slim && <span className="font-normal text-ink-soft lg:hidden">. Close the brief to see it.</span>}
      </h2>
      {slim && cue && <p data-cue-compact="" className="truncate text-sm text-ink lg:hidden">{cue.title}</p>}
      <div className={slim ? "hidden lg:block" : ""}>
      {cue ? (
        <>
          <p className="mt-0.5 text-xs text-ink-soft">{CUE_LABELS[cue.type]}, turn {cue.triggerTurn}</p>
          <h3 className="mt-2 break-words text-lg font-bold leading-snug">{cue.title}</h3>
          {cue.message && <p className="mt-1 break-words text-[15px] leading-6 text-ink">{cue.message}</p>}
          {cue.suggestedLine && (
            <p className="mt-3 break-words rounded-control border border-line bg-surface p-3 text-[15px] leading-6 text-ink">
              <span className="block text-xs text-ink-soft">{voice ? "Say something like" : "Suggested line"}</span>
              &ldquo;{cue.suggestedLine}&rdquo;
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {cue.suggestedLine && !voice && <button type="button" className="btn-primary min-h-[44px]" onClick={onUse}>Use line</button>}
            <button type="button" className="btn-ghost min-h-[44px]" onClick={onDismiss}>Hide cue</button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">No cue right now. One shows here when an objection lands or a step is due.</p>
      )}
      <p className="mt-3 text-xs text-ink-soft">{CUE_NOTE}</p>
      </div>
    </section>
  );
}

/** Talk-track progress as a disclosure, so the rail stays compact. Progress only, never a score. */
export function TalkTrackPanel({ steps, result, open = false }: { steps: string[]; result: CoachResult | null; open?: boolean }) {
  const done = result?.steps.filter(Boolean).length ?? 0;
  return (
    <details open={open || undefined}>
      <summary className="min-h-[44px] cursor-pointer py-2.5 text-sm font-semibold text-ink">
        Talk track <span className="font-normal text-ink-soft">{done} of {steps.length} steps done</span>
      </summary>
      <div className="pt-1"><TalkTrack steps={steps} result={result} /></div>
    </details>
  );
}

/** Cues before the one on screen, newest first: the history of what the coach said. */
export function EarlierCues({ cues, shownId }: { cues: LiveCue[]; shownId?: string }) {
  const earlier = cues.filter((c) => c.id !== shownId).slice(0, 4);
  if (!earlier.length) return null;
  return (
    <section aria-label="Earlier cues">
      <h2 className="text-sm font-semibold text-ink">Earlier cues</h2>
      <ul className="mt-2 space-y-1.5 text-sm">
        {earlier.map((c) => (
          <li key={c.id} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words text-ink-soft">{c.title}</span>
            <span className="shrink-0 text-xs text-ink-soft">{c.status === "used" ? "Used" : "Not used"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BlindNote() {
  return (
    <div className="rounded-panel border border-dashed border-line p-4 text-sm text-ink-soft">
      <p className="font-semibold text-ink">Blind mode</p>
      <p className="mt-1">No live help this call. You get the full debrief when you end it. Switch to Guided or Coached at any time.</p>
    </div>
  );
}

/** Which coach is running (the existing label: AI or rules-based, never a model) and the mode dial. */
export function CoachSettings({ mode, onModeChange, coachLabel }: { mode: CoachMode; onModeChange: (m: CoachMode) => void; coachLabel: string }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="chip-model"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode === "blind" ? "bg-ink-muted" : "bg-ok"}`} aria-hidden />{coachLabel}</span>
        <span className="text-xs text-ink-soft">Coach mode</span>
      </div>
      <ModeDial mode={mode} onChange={onModeChange} />
    </div>
  );
}

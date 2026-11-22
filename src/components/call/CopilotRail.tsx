"use client";

import { ArrowDown, ArrowUp, Check, CircleHelp, CornerDownLeft, Ear, EyeOff, Flag, Lock, PanelRightClose, PanelRightOpen, ShieldAlert, X } from "lucide-react";
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
const MODE_LINE: Record<CoachMode, string> = {
  blind: "No live help. You see your grade after the call.",
  guided: "Estimate, rubric and talk track. No cues.",
  coached: "Everything, including cues only you see.",
};

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

/** An SVG arc from angle a0 to a1 (degrees, 0 at twelve o'clock, clockwise). */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + r * Math.cos(((a - 90) * Math.PI) / 180), cy + r * Math.sin(((a - 90) * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/** One arc per talk-track step: reached arcs fill, the current one is drawn thicker. The same ring sits around the caller's light. */
export function StepsRing({ steps, total, size = 84, stroke = 3.5, gap = 11, className = "" }: { steps: boolean[]; total: number; size?: number; stroke?: number; gap?: number; className?: string }) {
  const n = Math.max(1, total), r = size / 2 - stroke * 1.5, c = size / 2, seg = 360 / n;
  const cur = Array.from({ length: n }, (_, i) => !!steps[i]).findIndex((d) => !d);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={className}>
      {Array.from({ length: n }, (_, i) => {
        const d = arcPath(c, c, r, i * seg + (n > 1 ? gap / 2 : 0), (i + 1) * seg - (n > 1 ? gap / 2 : 0.01));
        const on = !!steps[i];
        return <path key={i} d={d} fill="none" strokeLinecap="round" strokeWidth={i === cur ? stroke + 1 : stroke}
          className={`transition-colors duration-500 ${on ? "stroke-primary" : i === cur ? "stroke-ink-muted" : "stroke-line-strong"}`} />;
      })}
    </svg>
  );
}

/** The live estimate as a 270 degree gauge: hatched while no quote confirms a criterion, solid once one does. */
function Gauge({ value, solid, size = 92 }: { value: number | null; solid: boolean; size?: number }) {
  const c = size / 2, r = size / 2 - 6, v = value ?? 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <defs><pattern id="rail-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.5" height="5" className="fill-primary" /></pattern></defs>
      <path d={arcPath(c, c, r, -135, 135)} className="stroke-sunken" strokeWidth="5" fill="none" strokeLinecap="round" />
      {value !== null && <path d={arcPath(c, c, r, -135, -135 + 270 * Math.max(0.005, Math.min(1, v / 100)))} strokeWidth="5" fill="none" strokeLinecap="round"
        className={`transition-all duration-500 ${solid ? "stroke-primary" : ""}`} style={solid ? undefined : { stroke: "url(#rail-hatch)" }} />}
    </svg>
  );
}

/** A square state mark: half filled while provisional, filled with a check once a quote confirms it. */
function ProvMark({ confirmed, heard }: { confirmed: boolean; heard: boolean }) {
  if (!heard) return <span className="text-[12px] text-ink-muted">Not heard yet</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${confirmed ? "text-ok" : "text-caution"}`}>
      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
        {confirmed
          ? (<><rect x="1" y="1" width="12" height="12" rx="2.5" className="fill-current" /><path d="M4 7.2l2 2 4-4.4" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="stroke-surface" /></>)
          : (<><rect x="1.75" y="1.75" width="10.5" height="10.5" rx="2" fill="none" strokeWidth="1.5" className="stroke-current" /><path d="M1.75 7h10.5v3.25a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2z" className="fill-current" /></>)}
      </svg>
      {confirmed ? "Confirmed" : "Provisional"}
    </span>
  );
}

const talkWord = (ratio: number) => (ratio > 65 ? { w: "High", up: true } : ratio < 35 ? { w: "Low", up: false } : null);

/** Live estimate, talk track and talk ratio: the three instruments at the top of the drawer (and on the phone's coach bar). */
export function Instruments({ result, steps, compact = false }: { result: CoachResult | null; steps: string[]; compact?: boolean }) {
  const overall = result?.estimate.overall ?? 0;
  const done = result?.steps.filter(Boolean).length ?? 0;
  const ratio = Math.round((result?.talkRatio ?? 0) * 100);
  const ratioOk = ratio >= 35 && ratio <= 65;
  const confirmed = result?.estimate.criteria.filter((c) => c.confirmed).length ?? 0;
  const total = result?.estimate.criteria.length ?? 0;
  const word = result ? talkWord(ratio) : null;
  if (compact) {
    return (
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-[12px] font-semibold text-ink-soft">Live estimate</p>
          <p className={`mono text-2xl font-semibold leading-none ${result ? scoreTone(overall) : "text-ink-muted"}`}>{result ? overall : "--"}<span className="text-xs text-ink-muted">/100</span></p>
        </div>
        <div>
          <p className="text-[12px] font-semibold text-ink-soft">Talk track</p>
          <p className="mono text-2xl font-semibold leading-none text-ink">{done}<span className="text-xs text-ink-muted">/{steps.length}</span></p>
          <div className="mt-1.5 flex gap-0.5" aria-hidden>{steps.map((_, i) => <span key={i} className={`h-1 flex-1 rounded-full ${result?.steps[i] ? "bg-primary" : "bg-line-strong"}`} />)}</div>
        </div>
        <div>
          <p className="text-[12px] font-semibold text-ink-soft">You talk</p>
          <p className={`mono text-2xl font-semibold leading-none ${!result ? "text-ink-muted" : ratioOk ? "text-ink" : "text-caution"}`}>{result ? ratio : "--"}<span className="text-xs text-ink-muted">%</span></p>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-2 text-center">
      <div className="flex flex-col items-center">
        <p className="label !mb-1">Live estimate</p>
        <div className="relative grid place-items-center">
          <Gauge value={result ? overall : null} solid={confirmed >= 2} />
          <p className={`mono absolute font-heading text-[28px] font-semibold leading-none ${result ? "text-ink" : "text-ink-muted"}`}>{result ? overall : "--"}</p>
        </div>
        <p className="-mt-2 text-[12px] leading-tight text-ink-muted">Not final{result && total ? `, ${confirmed} of ${total} confirmed` : ""}</p>
      </div>
      <div className="flex flex-col items-center">
        <p className="label !mb-1">Talk track</p>
        <div className="relative grid h-[92px] place-items-center">
          <StepsRing steps={result?.steps ?? []} total={steps.length} />
          <p className="mono absolute font-heading text-[22px] font-semibold leading-none text-ink">{done}<span className="text-xs text-ink-muted">/{steps.length}</span></p>
        </div>
        <p className="-mt-2 text-[12px] leading-tight text-ink-muted">steps done</p>
      </div>
      <div className="flex flex-col items-center">
        <p className="label !mb-1">You talk</p>
        <div className="flex h-[92px] w-full flex-col items-center justify-center gap-3">
          <p className={`mono font-heading text-[28px] font-semibold leading-none ${!result ? "text-ink-muted" : ratioOk ? "text-ink" : "text-caution"}`}>{result ? ratio : "--"}<span className="text-xs text-ink-muted">%</span></p>
          <div className="relative h-1.5 w-full max-w-[86px] rounded-full bg-sunken" aria-hidden>
            <span className="absolute inset-y-0 rounded-full bg-ok/45" style={{ left: "35%", width: "30%" }} />
            {result && <span className="absolute -top-1 h-3.5 w-0.5 rounded bg-ink transition-[left] duration-500" style={{ left: `${ratio}%` }} />}
          </div>
        </div>
        <p className={`-mt-2 inline-flex items-center gap-1 text-[12px] leading-tight ${word ? "font-semibold text-caution" : "text-ink-muted"}`}>
          {!result ? "Waiting" : word ? <>{word.up ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />}{word.w}</> : <><Check size={12} aria-hidden />In range</>}
        </p>
      </div>
    </div>
  );
}

/**
 * Rubric rows: hatched while provisional, solid once a transcript quote confirms the criterion. A confirmed row carries a
 * turn chip that jumps to the quoted line when the call screen passes `onJump`.
 */
export function CriteriaTapes({ scenario, result, onJump }: { scenario: Scenario; result: CoachResult | null; onJump?: (line: number) => void }) {
  const total = scenario.rubric.reduce((a, c) => a + c.weight, 0) || 1;
  const rows = result?.estimate.criteria ?? scenario.rubric.map((c) => ({ id: c.id, name: c.name, weight: (c.weight / total) * 100, score: 0, confirmed: false, evidenceLine: undefined }));
  return (
    <ul className="divide-y divide-line">
      {rows.map((c) => {
        const heard = !!result && (c.score > 0 || c.confirmed);
        const pts = Math.round((c.score / 100) * c.weight);
        return (
          <li key={c.id} className="py-2.5 first:pt-0">
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13.5px]">
              <span className="min-w-0 truncate font-semibold text-ink">{c.name}</span>
              <span className="mono shrink-0 text-[12px] text-ink-muted">{Math.round(c.weight)}% · {heard && !c.confirmed ? "~" : ""}{heard ? pts : 0} pts</span>
            </div>
            <div className="tape !h-2" role="meter" aria-label={`${c.name}: ${Math.round(c.score)} of 100, ${c.confirmed ? "confirmed by a quote" : heard ? "provisional" : "not heard yet"}`} aria-valuenow={Math.round(c.score)} aria-valuemin={0} aria-valuemax={100}>
              <span className={`${scoreTone(c.score)} ${c.confirmed ? "bg-current" : "hatched"}`} style={{ width: `${heard ? Math.max(3, c.score) : 0}%` }} />
            </div>
            <div className="mt-1.5 flex min-h-[22px] items-center gap-2">
              <ProvMark confirmed={c.confirmed} heard={heard} />
              {c.confirmed && c.evidenceLine && onJump && (
                <button type="button" className="mono rounded-md border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft hover:border-primary hover:text-ink"
                  onClick={() => onJump(c.evidenceLine!)} aria-label={`Jump to the quote at turn ${c.evidenceLine}`}>T{c.evidenceLine}</button>
              )}
            </div>
          </li>
        );
      })}
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
          <li key={i} className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-[13.5px] ${now ? "bg-primary-soft/70" : ""}`}>
            <span className={`mono mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${done ? "border-primary bg-primary text-primary-on" : now ? "border-primary text-primary" : "border-line-strong text-ink-muted"}`} aria-hidden>
              {done ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            <span className={`min-w-0 flex-1 ${done ? "text-ink-muted" : now ? "font-semibold text-ink" : "text-ink-soft"}`}>{now && <span className="sr-only">Now: </span>}{s}</span>
            {now && <span className="shrink-0 rounded-full bg-primary px-2 py-px text-[11px] font-semibold text-primary-on" aria-hidden>Now</span>}
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
    <article className={`animate-cue-in rounded-panel border border-line-strong bg-sunken p-3.5 ${compact ? "" : "shadow-pop"}`}>
      <div className="flex items-start gap-2">
        <p className={`flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold ${CUE_TONE[cue.type].split(" ")[0]}`}>
          <Icon size={16} strokeWidth={1.9} className="shrink-0" aria-hidden /><span className="min-w-0">{CUE_LABELS[cue.type]}<span className="font-normal text-ink-muted">, turn {cue.triggerTurn}</span></span>
        </p>
        <button className="-m-1 rounded-full p-1.5 text-ink-muted hover:bg-surface hover:text-ink" onClick={onDismiss} aria-label={`Dismiss cue: ${cue.title}`}><X size={15} aria-hidden /></button>
      </div>
      {cue.heard && !compact && <p className="mt-2 text-[13px] text-ink-soft"><span className="mr-1.5 text-[12px] font-semibold text-ink-muted">Heard</span>&ldquo;{cue.heard}&rdquo;</p>}
      <p className="mt-1.5 text-[14px] font-semibold leading-snug text-ink">{cue.title}{cue.message && !compact ? <span className="font-normal text-ink-soft"> {cue.message}</span> : null}</p>
      {cue.suggestedLine && (
        <figure className="mt-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
          <figcaption className="text-[12px] font-semibold text-ink-muted">{voice ? "Say something like" : "Suggested line"}</figcaption>
          <blockquote className="mt-0.5 text-[14px] font-medium leading-snug text-ink">&ldquo;{cue.suggestedLine}&rdquo;</blockquote>
        </figure>
      )}
      {cue.suggestedLine && !voice && (
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className="btn-primary btn-sm !min-h-[36px] !px-4" onClick={onUse}><CornerDownLeft size={14} aria-hidden /> Use line</button>
          <button className="btn-quiet btn-sm !min-h-[36px]" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
    </article>
  );
}

export function ModeDial({ mode, onChange, disabled = false, withLine = false }: { mode: CoachMode; onChange: (m: CoachMode) => void; disabled?: boolean; withLine?: boolean }) {
  return (
    <div>
      <div className="grid grid-cols-3 gap-1 rounded-full bg-sunken p-1" role="radiogroup" aria-label="Coach mode" onKeyDown={disabled ? undefined : radioKeys(COACH_MODES, mode, onChange)}>
        {COACH_MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} disabled={disabled} onClick={() => onChange(m)}
            className={`min-h-[34px] rounded-full px-2 py-1.5 text-[13px] font-semibold transition ${mode === m ? "bg-surface text-ink shadow-card ring-1 ring-line-strong" : "text-ink-muted hover:text-ink"}`}>
            {COACH_MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {withLine && <p className="mt-1.5 text-[12px] text-ink-muted">{MODE_LINE[mode]}</p>}
    </div>
  );
}

/** The drawer folded to a narrow rail on wide screens: the estimate, steps done, waiting cues and the mode stay in view. */
function RailSpine({ result, steps, cues, mode, onExpand }: { result: CoachResult | null; steps: string[]; cues: number; mode: CoachMode; onExpand: () => void }) {
  const done = result?.steps.filter(Boolean).length ?? 0;
  const lit = { blind: 0, guided: 2, coached: 3 }[mode];
  return (
    <aside className="flex min-h-0 flex-1 flex-col items-center gap-4 border-l border-line bg-surface py-3" aria-label="Live grading, folded">
      <button type="button" className="btn-quiet !min-h-[40px] !px-2.5" onClick={onExpand} aria-label="Open the live grading drawer" title="Open the drawer (])"><PanelRightOpen size={18} aria-hidden /></button>
      {mode !== "blind" && (
        <>
          <p className="text-center leading-none"><span className="mono block font-heading text-[22px] font-semibold text-ink">{result ? result.estimate.overall : "--"}</span><span className="text-[11px] text-ink-muted">est.</span></p>
          <div className="relative grid place-items-center">
            <StepsRing steps={result?.steps ?? []} total={steps.length} size={40} stroke={2.5} gap={14} />
            <span className="mono absolute text-[11px] font-semibold">{done}/{steps.length}</span>
          </div>
        </>
      )}
      {cues > 0 && <span className="mono grid h-6 min-w-6 place-items-center rounded-full bg-primary px-1.5 text-[12px] font-bold text-primary-on" aria-label={`${cues} cue${cues > 1 ? "s" : ""} waiting`}>{cues}</span>}
      <span className="mt-auto flex flex-col gap-1" role="img" aria-label={`Coach mode ${COACH_MODE_LABELS[mode]}`}>
        {[0, 1, 2].map((i) => <i key={i} className={`h-1.5 w-1.5 rounded-full ${i < lit ? "bg-primary" : "bg-line-strong"}`} />)}
      </span>
    </aside>
  );
}

/** The live grading drawer beside the call: instruments, rubric, talk track, cue history, the open cue and the mode dial. */
export default function CopilotRail({ scenario, result, cues, mode, onModeChange, voice, onUseLine, onDismiss, coachLabel, error, onJump, collapsed = false, onCollapse }: {
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
  /** Scrolls the transcript to a quoted turn (1-based) and flashes it. */
  onJump?: (line: number) => void;
  /** Wide screens only: the drawer folds to a narrow rail. */
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}) {
  const steps = talkTrackSteps(scenario.callScript);
  const active = cues.filter((c) => c.status === "active");
  // The wide drawer pins the open cue above the dial. In the phone sheet it sits first in the cue section instead,
  // so the instruments and rubric keep the room (the call screen already docks it above the composer).
  const pinned = mode === "coached" && onCollapse ? active[0] : undefined;
  const waiting = pinned ? active.slice(1) : active;
  const earlier = cues.filter((c) => c.status !== "active").slice(0, 6);
  if (collapsed && onCollapse) return <RailSpine result={result} steps={steps} cues={mode === "coached" ? active.length : 0} mode={mode} onExpand={() => onCollapse(false)} />;
  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-surface lg:border-l lg:border-line" aria-label="Live grading">
      {onCollapse && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="font-heading text-[15px] font-bold">Live grading</h2>
          <span className="inline-flex items-center gap-1 text-[12px] text-ink-muted"><EyeOff size={13} aria-hidden />Only you see this</span>
          <button type="button" className="btn-quiet ml-auto !min-h-[34px] !px-2" onClick={() => onCollapse(true)} aria-label="Fold the drawer" title="Fold the drawer (])"><PanelRightClose size={17} aria-hidden /></button>
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {mode === "blind" ? (
          <div className="flex gap-3 rounded-panel border border-dashed border-line-strong p-4 text-sm text-ink-soft">
            <Lock size={18} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
            <p><span className="font-semibold text-ink">Blind mode.</span> No live help this call. You get the full debrief when you end it. Switch to Guided or Coached below at any time.</p>
          </div>
        ) : (
          <>
            <section aria-label="Live instruments"><Instruments result={result} steps={steps} /></section>
            <section aria-labelledby="rail-rubric">
              <h2 id="rail-rubric" className="label flex items-baseline gap-2">Rubric <span className="text-[12px] font-normal text-ink-muted">Same weights as your final grade</span></h2>
              <CriteriaTapes scenario={scenario} result={result} onJump={onJump} />
            </section>
            <section aria-labelledby="rail-track">
              <h2 id="rail-track" className="label flex items-baseline justify-between gap-2">Talk track <span className="mono text-[12px] font-normal text-ink-muted">{result?.steps.filter(Boolean).length ?? 0} of {steps.length}</span></h2>
              <TalkTrack steps={steps} result={result} />
            </section>
            {mode === "coached" && (
              <section aria-labelledby="rail-cues">
                <h2 id="rail-cues" className="label flex items-baseline gap-2">Coach cues <span className="text-[12px] font-normal text-ink-muted">{cues.length ? `${cues.length} this call` : "Only you see these"}</span></h2>
                {cues.length === 0 && (
                  <p className="rounded-panel border border-dashed border-line-strong p-3 text-[13px] text-ink-muted">Cues appear here when an objection lands, a talk-track step is due, or you drift. The caller never hears them.</p>
                )}
                {waiting.length > 0 && (
                  <div className="space-y-2.5">{waiting.map((c, i) => <CueCard key={c.id} cue={c} voice={voice} compact={!!pinned || i > 0} onUse={() => onUseLine(c)} onDismiss={() => onDismiss(c.id)} />)}</div>
                )}
                {earlier.length > 0 && (
                  <ul className={`space-y-1.5 ${waiting.length ? "mt-3 border-t border-line pt-3" : ""}`}>
                    {earlier.map((c) => (
                      <li key={c.id} className="flex items-center gap-2 text-[12.5px] text-ink-muted">
                        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${c.status === "used" ? "bg-ok-soft text-ok" : "bg-sunken"}`} aria-hidden>{c.status === "used" ? <Check size={12} /> : <X size={12} />}</span>
                        <span className="min-w-0 truncate"><span className={`font-semibold ${c.status === "used" ? "text-ok" : "text-ink-soft"}`}>{c.status === "used" ? "Used" : "Dismissed"}</span>, turn {c.triggerTurn}, {c.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
        {error && <p className="rounded-xl bg-caution-soft p-2.5 text-[12px] text-ink" role="status">{error}</p>}
      </div>
      {/* The open cue docks above the mode dial, so it never sits below the fold of the drawer. */}
      {pinned && (
        <div className="scroll-thin max-h-[46%] shrink-0 overflow-y-auto border-t border-line bg-surface p-3">
          <CueCard key={pinned.id} cue={pinned} voice={voice} onUse={() => onUseLine(pinned)} onDismiss={() => onDismiss(pinned.id)} />
        </div>
      )}
      <div className="shrink-0 space-y-2 border-t border-line p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink-soft">Coach mode</span>
          <span className="chip-model"><span className={`lamp ${mode === "blind" ? "lamp-off" : "lamp-ok"} !h-1.5 !w-1.5`} aria-hidden />{coachLabel}</span>
        </div>
        <ModeDial mode={mode} onChange={onModeChange} withLine />
      </div>
    </aside>
  );
}

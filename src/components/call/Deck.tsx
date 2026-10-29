"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Loader2, Mic, MicOff, PhoneOff, Send, Target, X } from "lucide-react";
import { CUE_LABELS, type CoachMode } from "@/lib/coach-types";
import { talkTrackSteps, type Scenario } from "@/lib/scenarios";
import type { StoredTurn } from "@/lib/sessionStore";
import { formatDuration } from "@/lib/format";
import CallOrb, { type AgentState } from "@/components/CallOrb";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import CopilotRail, { CueCard, Instruments } from "./CopilotRail";
import type { LiveCue, RubricChip, useCoach } from "./useCoach";

export interface DeckText {
  value: string; onChange: (v: string) => void; onSend: () => void; hungUp: boolean; typing: boolean;
  /** Who plays the persona, e.g. "Text · gpt-4.1-mini" or "Text · scripted". */
  caller?: string;
}
export interface DeckVoice { muted: boolean; onToggleMute: () => void; getInputVolume: () => number; getOutputVolume: () => number; engine?: "openai" | "elevenlabs" }

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
const clock = (iso: string | undefined, start: number) => (iso ? formatDuration(Math.max(0, Math.round((Date.parse(iso) - start) / 1000))) : "");

export default function Deck({ scenario, turns, startedAt, elapsed, orbState, status, grading, gradingLabel, onEnd, coach, coachMode, onCoachModeChange, coachLabel, text, voice, inserted, onInsert, error }: {
  error?: string;
  scenario: Scenario;
  turns: StoredTurn[];
  startedAt: number;
  elapsed: number;
  orbState: AgentState;
  status: { label: string; tone: "ok" | "signal" | "caution" };
  grading: boolean;
  gradingLabel: string;
  onEnd: () => void;
  coach: ReturnType<typeof useCoach>;
  coachMode: CoachMode;
  onCoachModeChange: (m: CoachMode) => void;
  coachLabel: string;
  text?: DeckText;
  voice?: DeckVoice;
  inserted: boolean;
  onInsert: (cue: LiveCue) => void;
}) {
  const persona = scenario.aiPersona;
  const logRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [sheet, setSheet] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [announce, setAnnounce] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetClose = useRef<HTMLButtonElement>(null);
  const sheetOpener = useRef<HTMLButtonElement>(null);
  /** Where focus goes when the coach sheet closes: back to its opener, or to the composer after "Use line". */
  const afterSheet = useRef<"opener" | "composer">("opener");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const announced = useRef<string | null>(null);
  const steps = talkTrackSteps(scenario.callScript);
  const activeCue = coach.cues.find((c) => c.status === "active");
  const objectionTurns = new Set(coach.cues.filter((c) => c.type === "objection" && c.status === "active").map((c) => c.triggerTurn));
  const isVoice = !!voice;

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, text?.typing]);

  // Esc closes the coach sheet when it is open, else asks before ending; Space toggles mute in voice mode (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sheet) { setSheet(false); return; }
      if (e.key === "Escape" && !grading) setConfirmEnd(true);
      if (e.key === " " && voice && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement)) { e.preventDefault(); voice.onToggleMute(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grading, voice, sheet]);

  // The phone coach sheet is a real modal: focus moves in on open and goes back out on close.
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheet) sheetClose.current?.focus();
    else if (sheetWasOpen.current) (afterSheet.current === "composer" && replyRef.current ? replyRef.current : sheetOpener.current)?.focus();
    sheetWasOpen.current = sheet;
    afterSheet.current = "opener";
  }, [sheet]);

  function trapSheet(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // A new cue card is not announced on its own, so read it out through one region that is always on the page.
  const newest = coach.cues[0];
  useEffect(() => {
    if (!newest || newest.id === announced.current) return;
    announced.current = newest.id;
    if (newest.status === "active" && coachMode === "coached") setAnnounce(`${CUE_LABELS[newest.type]}: ${newest.title.replace(/[.!?]$/, "")}.${newest.suggestedLine ? ` ${newest.suggestedLine}` : ""}`);
  }, [newest, coachMode]);

  /** "Use line" removes the card that had focus, so focus goes to the composer that now holds the line. */
  function insertLine(cue: LiveCue) {
    onInsert(cue);
    if (text) requestAnimationFrame(() => replyRef.current?.focus());
  }

  function endClicked() {
    if (window.matchMedia("(max-width: 1023px)").matches) setConfirmEnd(true);
    else onEnd();
  }

  const chipsFor = (i: number): RubricChip[] => coach.chips[i] ?? [];
  const source = voice ? (voice.engine === "openai" ? "Voice · OpenAI Realtime" : "Voice · ElevenLabs") : text?.caller ?? "Text simulation";
  const toneClass = { ok: "lamp-ok", signal: "lamp-signal", caution: "lamp-caution" }[status.tone];

  return (
    <div className="deck fixed inset-0 z-50 flex flex-col pt-[env(safe-area-inset-top)]">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
        <CallOrb state={orbState} getInputVolume={voice?.getInputVolume} getOutputVolume={voice?.getOutputVolume}
          manual={voice ? undefined : { input: orbState === "listening" ? 0.25 : 0, output: orbState === "talking" ? 0.6 : 0 }} className="h-9 w-9 shrink-0" />
        <div className="min-w-0">
          <p className="truncate font-heading text-sm font-bold sm:text-[15px]">{persona.name}</p>
          <p className="hidden truncate text-xs text-ink-muted sm:block">{scenario.title}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-ink-soft sm:hidden" aria-hidden><span className={`lamp ${toneClass} !h-1.5 !w-1.5`} />{status.label}</p>
        </div>
        {/* Phones show the status under the name; the pill stays in the accessibility tree at every width so changes are announced. */}
        <span className="sr-only ml-1 items-center gap-2 rounded-full border border-line bg-sunken px-3 py-1 text-xs font-semibold sm:not-sr-only sm:inline-flex" role="status">
          <span className={`lamp ${toneClass} ${status.tone === "signal" ? "motion-safe:animate-lamp-pulse" : ""}`} aria-hidden />{status.label}
        </span>
        <span className="mono ml-auto text-lg font-semibold tabular-nums sm:text-xl" aria-label={`Elapsed ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</span>
        <span className="chip-model hidden md:inline-flex">{source}</span>
        {voice && (
          <button className={`btn-ghost !min-h-[38px] !px-3 ${voice.muted ? "!border-alert/60 !text-alert" : ""}`} onClick={voice.onToggleMute} disabled={grading}
            aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}>
            {voice.muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}<span className="hidden sm:inline" aria-hidden>{voice.muted ? "Unmute" : "Mute"}</span><span className="kbd hidden lg:inline-flex" aria-hidden>Space</span>
          </button>
        )}
        <button className="btn-danger !min-h-[38px] !px-3 sm:!px-4" onClick={endClicked} disabled={grading} aria-label={text?.hungUp ? "Grade this call" : "End and grade call"}>
          <PhoneOff size={16} aria-hidden /><span className="hidden sm:inline">{text?.hungUp ? "Grade call" : "End & grade"}</span><span className="kbd hidden !border-alert-on/30 !bg-transparent !text-alert-on lg:inline-flex">Esc</span>
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Transcript column */}
        <section className="flex min-h-0 flex-col" aria-label="Call">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] sm:px-6">
            <Target size={14} className="shrink-0 text-primary" aria-hidden />
            <p className="min-w-0 flex-1 truncate"><span className="font-semibold">Goal:</span> <span className="text-ink-soft">{scenario.traineeGoal}</span></p>
            <span className="mono shrink-0 text-[11px] text-ink-muted">{turns.length} turns<span className="md:hidden"> · {source}</span></span>
          </div>

          <ol ref={logRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-4 sm:px-4" aria-live="polite" aria-label="Live transcript">
            {turns.length === 0 && !text?.typing && <li className="py-10 text-center text-sm text-ink-muted">{isVoice ? "Connecting the call. Say hello when you hear them." : "The transcript appears here as you talk."}</li>}
            {turns.map((t, i) => {
              const me = t.role === "user";
              const objection = objectionTurns.has(i + 1);
              return (
                <li key={i} className={`grid grid-cols-[48px_minmax(0,1fr)] gap-3 rounded-lg px-2 py-2.5 sm:grid-cols-[64px_minmax(0,1fr)] ${objection ? "bg-alert-soft/60 ring-1 ring-alert/40" : ""}`}>
                  <div className="pt-0.5 font-mono text-[11px] leading-tight text-ink-muted">T{i + 1}<br />{clock(t.timestamp, startedAt)}</div>
                  <div className="min-w-0">
                    <p className={`font-mono text-[11px] font-medium uppercase tracking-wide ${me ? "text-primary" : "text-ink-muted"}`}>{me ? "You" : persona.name}</p>
                    <p className={`mt-0.5 text-[15px] leading-relaxed ${me ? "text-ink" : "text-ink-soft"}`}>{t.text}</p>
                    {objection && <p className="mt-1.5 text-xs font-semibold text-alert">Objection detected · cue in the coach rail</p>}
                    {me && chipsFor(i).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {chipsFor(i).map((c) => <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-ok-soft px-1.5 py-0.5 font-mono text-[11px] text-ok">▲ {c.name} +{c.delta}</span>)}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            {text?.typing && (
              <li className="grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-2 py-2.5 sm:grid-cols-[64px_minmax(0,1fr)]">
                <span />
                <p className="flex items-center gap-1.5 text-sm text-ink-muted" aria-label={`${persona.name} is typing`}>
                  {[0, 150, 300].map((d) => <span key={d} className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
                </p>
              </li>
            )}
          </ol>

          {/* Phone: latest cue docks above the composer, and the rail opens as a sheet. */}
          <div className="shrink-0 space-y-2 px-3 lg:hidden">
            {activeCue && coachMode === "coached" && (
              <CueCard cue={activeCue} voice={isVoice} compact onUse={() => insertLine(activeCue)} onDismiss={() => coach.dismiss(activeCue.id)} />
            )}
            {coachMode !== "blind" && (
              <button ref={sheetOpener} type="button" className="flex w-full items-center gap-3 rounded-panel border border-line bg-surface px-3 py-2 text-left" onClick={() => setSheet(true)} aria-label="Open the coach rail" aria-haspopup="dialog">
                <div className="min-w-0 flex-1"><Instruments result={coach.result} steps={steps} compact /></div>
                <ChevronUp size={18} className="shrink-0 text-ink-muted" aria-hidden />
              </button>
            )}
          </div>

          <div className="shrink-0 border-t border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
            {error && <p role="alert" className="mb-3 rounded-panel border border-alert/40 bg-alert-soft p-3 text-sm">{error}</p>}
            {text?.hungUp && (
              <div className="mb-3 flex flex-col items-center gap-2 rounded-panel bg-caution-soft p-3 text-center text-sm sm:flex-row sm:justify-between sm:text-left" role="status">
                <span><strong>{persona.name} hung up.</strong> The call is over.</span>
                <button className="btn-primary btn-sm" onClick={onEnd} disabled={grading}>Grade this call</button>
              </div>
            )}
            {text && !text.hungUp && (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); text.onSend(); }}>
                {inserted && <p className="font-mono text-[11px] text-ink-muted">↳ Line inserted from the coach. Edit it or send it. Nothing is auto-sent.</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={replyRef}
                    className="input min-h-[46px] resize-none !rounded-xl !py-3 leading-snug"
                    rows={inserted ? 3 : 1}
                    value={grading ? "" : text.value}
                    onChange={(e) => text.onChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); text.onSend(); } }}
                    placeholder={grading ? "Grading…" : "Type what you would say…"}
                    aria-label="Your reply"
                    autoFocus
                    disabled={grading}
                  />
                  <button className="btn-primary !h-[46px] !min-w-[46px] !rounded-xl !px-3.5" disabled={grading || !text.value.trim()} aria-label="Send"><Send size={17} aria-hidden /></button>
                </div>
                <p className="hidden font-mono text-[10px] text-ink-muted sm:block"><span className="kbd">Enter</span> send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> new line · <span className="kbd">Esc</span> end call</p>
              </form>
            )}
            {voice && (
              <p className="flex items-center justify-center gap-2 py-1 text-sm text-ink-soft">
                <span className={`lamp ${voice.muted ? "lamp-alert" : "lamp-ok"}`} aria-hidden />
                {voice.muted ? "Your mic is muted." : "Mic is live. Just talk; the transcript and coach follow along."}
              </p>
            )}
          </div>
        </section>

        <div className="hidden min-h-0 lg:flex lg:flex-col">
          <CopilotRail scenario={scenario} result={coach.result} cues={coach.cues} mode={coachMode} onModeChange={onCoachModeChange} voice={isVoice}
            onUseLine={insertLine} onDismiss={coach.dismiss} coachLabel={coachLabel} error={coach.error} />
        </div>
      </div>

      {sheet && (
        <div className="fixed inset-0 z-[60] flex items-end bg-[rgb(var(--shadow)/0.5)] lg:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div ref={sheetRef} onKeyDown={trapSheet} className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-sheet border border-line bg-surface animate-cue-in" role="dialog" aria-modal="true" aria-label="Coach">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <p className="font-heading text-sm font-bold">Coach</p>
              <button ref={sheetClose} type="button" className="btn-quiet !min-h-[36px] !px-2" onClick={() => setSheet(false)} aria-label="Close coach"><X size={18} aria-hidden /></button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
              <CopilotRail scenario={scenario} result={coach.result} cues={coach.cues} mode={coachMode} onModeChange={onCoachModeChange} voice={isVoice}
                onUseLine={(c) => { onInsert(c); afterSheet.current = "composer"; setSheet(false); }} onDismiss={coach.dismiss} coachLabel={coachLabel} error={coach.error} />
            </div>
          </div>
        </div>
      )}

      <p className="sr-only" aria-live="assertive" aria-atomic="true">{announce}</p>

      {grading && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 backdrop-blur-sm" role="status">
          <div className="panel flex items-center gap-3 px-5 py-4">
            <Loader2 size={18} className="animate-spin text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Grading the full call</p>
              <p className="font-mono text-[11px] text-ink-muted">{gradingLabel}</p>
            </div>
          </div>
        </div>
      )}

      {confirmEnd && (
        <ConfirmDialog title="End the call and grade it?" message="You'll get a full debrief with scores, evidence and a retry point." confirmLabel="End & grade"
          onConfirm={() => { setConfirmEnd(false); onEnd(); }} onCancel={() => setConfirmEnd(false)} />
      )}
    </div>
  );
}

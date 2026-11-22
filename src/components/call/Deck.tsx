"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Loader2, Mic, MicOff, PhoneOff, Send, Target, X } from "lucide-react";
import { COACH_MODE_LABELS, CUE_LABELS, type CoachMode } from "@/lib/coach-types";
import { talkTrackSteps, type Scenario } from "@/lib/scenarios";
import type { StoredTurn } from "@/lib/sessionStore";
import { formatDuration } from "@/lib/format";
import { NEXT_CALL_STANDARD_NOTICE, TRIAL_CALL_NOTICE, liveCallLimitNotice, voiceLabel } from "@/lib/billingUi";
import type { AgentState } from "@/components/CallOrb";
import VoiceLight, { idleLevel, talkLevel, type LightLevel } from "@/components/ui/VoiceLight";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import CallError from "./CallError";
import CopilotRail, { CueCard, Instruments, StepsRing } from "./CopilotRail";
import type { LiveCue, RubricChip, useCoach } from "./useCoach";

export interface DeckText {
  value: string; onChange: (v: string) => void; onSend: () => void; hungUp: boolean; typing: boolean;
  /** Who plays the persona: "Text · AI" or "Text · scripted". Never a model id. */
  caller?: string;
}
export interface DeckVoice {
  muted: boolean; onToggleMute: () => void; getInputVolume: () => number; getOutputVolume: () => number; engine?: "openai" | "elevenlabs";
  /** Voice tier this call was minted on. A label only; never a model id. */
  tier?: "premium" | "standard";
  /** This Premium call holds the last Premium minutes: the next call is Standard. */
  nextCallStandard?: boolean;
  /** The organization's one Premium trial call. Changes only the notice wording. */
  trial?: boolean;
  /** The server's deadline for THIS call (its normal end), in seconds. */
  maxSeconds?: number;
}

/**
 * The polite live notice under the static voice label (Prism finding 2). The trial call keeps its own 5 minute notice.
 * A paid Premium call that holds the last Premium minutes says when THIS call ends (the server's deadline) and that
 * the next one is Standard. A Standard call (chosen or not) has no Premium cutoff, so it says nothing.
 */
export function liveVoiceNotice(v: Pick<DeckVoice, "tier" | "trial" | "nextCallStandard" | "maxSeconds"> | undefined): string {
  if (!v || v.tier !== "premium") return "";
  if (v.trial) return TRIAL_CALL_NOTICE;
  if (!v.nextCallStandard) return "";
  return v.maxSeconds ? liveCallLimitNotice(v.maxSeconds) : NEXT_CALL_STANDARD_NOTICE;
}

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
const clock = (iso: string | undefined, start: number) => (iso ? formatDuration(Math.max(0, Math.round((Date.parse(iso) - start) / 1000))) : "");

export default function Deck({ scenario, turns, startedAt, elapsed, orbState, status, grading, gradingLabel, onEnd, coach, coachMode, onCoachModeChange, coachLabel, text, voice, inserted, onInsert, error, canUpgrade = true }: {
  error?: string;
  /** False for a Team pool member who is not an owner or manager: the cap message says to ask their admin, with no Upgrade link. */
  canUpgrade?: boolean;
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
  /** Turns already on screen when the call opened (a retry seeds them) arrive whole; new caller lines arrive word by word. */
  const seeded = useRef(turns.length);
  /** Wide screens can fold the drawer to a narrow rail (button or the ] key); the call takes the room. */
  const [railFolded, setRailFolded] = useState(false);
  /** The turn a drawer chip jumped to, flashed for a moment. */
  const [flash, setFlash] = useState<{ line: number; at: number } | null>(null);
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
      const typingInField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === " " && voice && !(typingInField || e.target instanceof HTMLButtonElement)) { e.preventDefault(); voice.onToggleMute(); }
      if (e.key === "]" && !typingInField && window.matchMedia("(min-width: 1024px)").matches) setRailFolded((f) => !f);
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
  /** A drawer chip (T4) scrolls the transcript to that turn and flashes it; the phone sheet closes first. */
  function jumpTo(line: number) {
    setSheet(false);
    stick.current = false;
    requestAnimationFrame(() => document.getElementById(`turn-${line}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    setFlash({ line, at: Date.now() });
  }
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(id);
  }, [flash]);
  /** The caller's light: their audio level on a voice call, a spoken rhythm while a text reply lands, a slow breath otherwise. */
  const lightLevel = (t: number): LightLevel => {
    if (grading) return { level: 0.06, turbulence: 0.2 };
    if (voice) {
      const out = Math.min(1, voice.getOutputVolume() * 3.2);
      if (out > 0.05) return { level: 0.2 + 0.8 * out, turbulence: 0.4 + 0.5 * out };
      return { ...idleLevel(t), listening: voice.getInputVolume() * 3 > 0.12 };
    }
    if (orbState === "talking") return talkLevel(t);
    if (orbState === "thinking") return { level: 0.1 + 0.04 * Math.sin(t * 6), turbulence: 0.5 };
    return idleLevel(t);
  };
  const stepsDone = coachMode === "blind" ? [] : coach.result?.steps ?? [];
  const lastCaller = turns.reduce((at, t, i) => (t.role === "user" ? at : i), -1);
  const callKind = `${isVoice ? "Voice" : "Text"} call, ${COACH_MODE_LABELS[coachMode].toLowerCase()}`;
  const source = voice ? (voice.engine === "openai" ? "Voice · OpenAI Realtime" : "Voice · ElevenLabs") : text?.caller ?? "Text simulation";
  const toneClass = { ok: "lamp-ok", signal: "lamp-signal", caution: "lamp-caution" }[status.tone];

  return (
    <div className="stage stage-backdrop fixed inset-0 z-50 flex flex-col pt-[env(safe-area-inset-top)]">
      {/* Top bar: who you are talking to, the kind of call, the clock and the way out. */}
      <header className="relative z-[1] flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 sm:h-16 sm:px-5">
        <div className="min-w-0">
          <p className="truncate font-heading text-[16px] font-bold tracking-[-0.01em] sm:text-[18px]">{persona.name}</p>
          <p className="hidden truncate text-[13px] text-ink-muted sm:block">{scenario.title}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-ink-soft sm:hidden" aria-hidden><span className={`lamp ${toneClass} !h-1.5 !w-1.5`} />{status.label}</p>
        </div>
        {/* Phones show the status under the name; the pill stays in the accessibility tree at every width so changes are announced. */}
        <span className="sr-only ml-1 items-center gap-2 rounded-full border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-semibold sm:not-sr-only sm:inline-flex" role="status">
          <span className={`lamp ${toneClass} ${status.tone === "signal" ? "motion-safe:animate-lamp-pulse" : ""}`} aria-hidden />{status.label}
        </span>
        <span className="ml-auto font-heading text-[22px] font-medium leading-none tabular-nums tracking-[-0.01em] sm:text-[26px]" aria-label={`Elapsed ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</span>
        <span className="chip-model hidden md:inline-flex">{source}</span>
        {voice && (
          <button className={`btn-ghost !min-h-[40px] !px-3 ${voice.muted ? "!border-alert/60 !text-alert" : ""}`} onClick={voice.onToggleMute} disabled={grading}
            aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}>
            {voice.muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}<span className="hidden sm:inline" aria-hidden>{voice.muted ? "Unmute" : "Mute"}</span><span className="kbd hidden lg:inline-flex" aria-hidden>Space</span>
          </button>
        )}
        <button className={`btn-danger !min-h-[40px] !px-3 sm:!px-4 ${text?.hungUp ? "end-ready" : ""}`} onClick={endClicked} disabled={grading} aria-label={text?.hungUp ? "Grade this call" : "End and grade call"}>
          <PhoneOff size={16} aria-hidden /><span className="hidden sm:inline">{text?.hungUp ? "Grade call" : "End & grade"}</span><span className="kbd hidden !border-alert-on/30 !bg-transparent !text-alert-on lg:inline-flex">Esc</span>
        </button>
      </header>

      <div className={`relative z-[1] grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] ${railFolded ? "lg:grid-cols-[minmax(0,1fr)_64px]" : "lg:grid-cols-[minmax(0,1fr)_400px]"}`}>
        {/* The stage: the caller's light inside the talk-track ring, the goal, then the captions. */}
        <section className="flex min-h-0 flex-col" aria-label="Call">
          <div className={`flex shrink-0 flex-col items-center pt-2 lg:pt-6 [@media(max-height:640px)]:hidden ${activeCue && coachMode === "coached" ? "max-lg:hidden" : ""}`} aria-hidden>
            {/* On phones the light gives way to a docked cue, and stays small otherwise, so the captions keep their room. */}
            <div className="relative grid size-[clamp(88px,16dvh,150px)] place-items-center lg:size-[clamp(140px,24dvh,236px)]">
              <StepsRing steps={stepsDone} total={steps.length} size={240} stroke={3} gap={8} className="absolute inset-0 h-full w-full" />
              <VoiceLight getLevel={lightLevel} className="size-[80%]" />
            </div>
            <p className="mt-1 flex min-h-[22px] items-center gap-2 text-[14px] text-ink-muted">{voice?.muted && <MicOff size={14} aria-hidden />}{coachMode === "blind" ? callKind : `${stepsDone.filter(Boolean).length} of ${steps.length} talk-track steps`}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-2 text-[13px] sm:px-6">
            <Target size={14} className="shrink-0 text-primary" aria-hidden />
            <p className="min-w-0 flex-1 truncate"><span className="font-semibold">Goal:</span> <span className="text-ink-soft">{scenario.traineeGoal}</span></p>
            <span className="mono shrink-0 text-[12px] text-ink-muted">{turns.length} turns<span className="md:hidden"> · {source}</span></span>
          </div>

          {/* Captions: the caller's newest line is large and arrives word by word through amber; older lines settle back. */}
          <ol ref={logRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            className="scroll-thin flex min-h-[5rem] flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-2 pb-4 pt-5 [mask-image:linear-gradient(to_bottom,transparent_0,black_32px)] sm:px-4" aria-live="polite" aria-label="Live transcript">
            {turns.length === 0 && !text?.typing && <li className="my-auto text-center text-[15px] text-ink-muted">{isVoice ? "Connecting the call. Say hello when you hear them." : "The transcript appears here as you talk."}</li>}
            {turns.map((t, i) => {
              const me = t.role === "user";
              const objection = objectionTurns.has(i + 1);
              const latest = !me && i === lastCaller;
              const arriving = latest && i >= seeded.current;
              return (
                <li key={i} id={`turn-${i + 1}`} className={`${i === 0 ? "mt-auto" : ""} mx-auto grid w-full max-w-[860px] grid-cols-[44px_minmax(0,1fr)] gap-3 rounded-xl px-2 py-2.5 sm:grid-cols-[56px_minmax(0,1fr)] ${objection ? "bg-alert-soft/60 ring-1 ring-alert/40" : ""} ${flash?.line === i + 1 ? "turn-flash" : ""}`}>
                  <div className="pt-1 text-[12px] leading-tight text-ink-muted"><span className="mono">T{i + 1}</span><br /><span className="mono">{clock(t.timestamp, startedAt)}</span></div>
                  <div className="min-w-0">
                    <p className={`text-[13px] font-semibold ${me ? "text-primary" : "text-ink-muted"}`}>{me ? "You" : persona.name}</p>
                    <p className={`mt-0.5 whitespace-pre-wrap break-words ${latest ? "text-[20px] font-medium leading-[28px] tracking-[-0.005em] text-ink sm:text-[24px] sm:leading-[32px]" : me ? "text-[15px] leading-relaxed text-ink" : "text-[15px] leading-relaxed text-ink-soft"}`}>
                      {arriving ? t.text.split(/(\s+)/).map((w, k) => (/^\s+$/.test(w) ? w : <span key={k} className="w-in" style={{ animationDelay: `${(k / 2) * 0.32}s` }}>{w}</span>)) : t.text}
                    </p>
                    {objection && <p className="mt-1.5 text-[13px] font-semibold text-alert">Objection detected. The coach has a cue for it.</p>}
                    {me && chipsFor(i).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {chipsFor(i).map((c) => <span key={c.id} className="inline-flex items-center gap-1 rounded-full border border-ok/40 bg-ok-soft px-2 py-0.5 text-[12px] font-semibold text-ok">▲ {c.name} +{c.delta}</span>)}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            {text?.typing && (
              <li className={`${turns.length === 0 ? "mt-auto" : ""} mx-auto grid w-full max-w-[860px] grid-cols-[44px_minmax(0,1fr)] gap-3 px-2 py-2.5 sm:grid-cols-[56px_minmax(0,1fr)]`}>
                <span />
                <p className="flex items-center gap-1.5 text-sm text-ink-muted" aria-label={`${persona.name} is typing`}>
                  {[0, 150, 300].map((d) => <span key={d} className="h-1.5 w-1.5 rounded-full bg-amber motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
                </p>
              </li>
            )}
          </ol>

          {/* Phone: latest cue docks above the composer, and the drawer opens as a sheet. */}
          <div className="scroll-thin max-h-[42dvh] shrink-0 space-y-2 overflow-y-auto px-3 pb-2 lg:hidden">
            {activeCue && coachMode === "coached" && (
              <CueCard cue={activeCue} voice={isVoice} compact onUse={() => insertLine(activeCue)} onDismiss={() => coach.dismiss(activeCue.id)} />
            )}
            {coachMode !== "blind" && (
              <button ref={sheetOpener} type="button" className="flex w-full items-center gap-3 rounded-panel border border-line-strong bg-surface px-3.5 py-2.5 text-left" onClick={() => setSheet(true)} aria-label="Open live grading" aria-haspopup="dialog">
                <div className="min-w-0 flex-1"><Instruments result={coach.result} steps={steps} compact /></div>
                <ChevronUp size={18} className="shrink-0 text-ink-muted" aria-hidden />
              </button>
            )}
          </div>

          <div className="shrink-0 border-t border-line bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
            {error && <CallError message={error} className="mb-3" canUpgrade={canUpgrade} />}
            {text?.hungUp && (
              <div className="mb-3 flex flex-col items-center gap-2 rounded-panel bg-caution-soft p-3 text-center text-sm sm:flex-row sm:justify-between sm:text-left" role="status">
                <span><strong>{persona.name} hung up.</strong> The call is over.</span>
                <button className="btn-primary btn-sm" onClick={onEnd} disabled={grading}>Grade this call</button>
              </div>
            )}
            {text && !text.hungUp && (
              <form className="mx-auto max-w-[860px] space-y-2" onSubmit={(e) => { e.preventDefault(); text.onSend(); }}>
                {inserted && <p className="text-[13px] text-ink-soft"><span className="mr-1.5 rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-semibold text-primary">From coach</span>Line added to your reply. Edit it or send it. Nothing is sent for you.</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={replyRef}
                    className="input min-h-[48px] resize-none !rounded-2xl !py-3 leading-snug"
                    rows={inserted ? 3 : 1}
                    value={grading ? "" : text.value}
                    onChange={(e) => text.onChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); text.onSend(); } }}
                    placeholder={grading ? "Grading…" : "Type what you would say…"}
                    aria-label="Your reply"
                    autoFocus
                    disabled={grading}
                  />
                  <button className="btn-primary !h-[48px] !min-w-[48px] !px-3.5" disabled={grading || !text.value.trim()} aria-label="Send"><Send size={17} aria-hidden /></button>
                </div>
                <p className="hidden text-[12px] text-ink-muted sm:block"><span className="kbd">Enter</span> send · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> new line · <span className="kbd">Esc</span> end call</p>
              </form>
            )}
            {voice && (
              <p className="flex items-center justify-center gap-2 py-1 text-sm text-ink-soft">
                <span className={`lamp ${voice.muted ? "lamp-alert" : "lamp-ok"}`} aria-hidden />
                {voice.muted ? "Your mic is muted." : "Mic is live. Just talk; the captions and coach follow along."}
              </p>
            )}
            {/* Static for the whole call: the voice never changes mid-call. The notice is announced once, politely. */}
            {voice?.tier && (
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1 text-xs text-ink-muted">
                <span className="chip">{voiceLabel(voice.tier)}</span>
                <p aria-live="polite" className="min-w-0 text-center">{liveVoiceNotice(voice)}</p>
              </div>
            )}
          </div>
        </section>

        <div className="hidden min-h-0 lg:flex lg:flex-col">
          <CopilotRail scenario={scenario} result={coach.result} cues={coach.cues} mode={coachMode} onModeChange={onCoachModeChange} voice={isVoice}
            onUseLine={insertLine} onDismiss={coach.dismiss} coachLabel={coachLabel} error={coach.error} onJump={jumpTo} collapsed={railFolded} onCollapse={setRailFolded} />
        </div>
      </div>

      {sheet && (
        <div className="fixed inset-0 z-[60] flex items-end bg-[rgb(var(--shadow)/0.5)] lg:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(false); }}>
          <div ref={sheetRef} onKeyDown={trapSheet} className="flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-sheet border border-line-strong bg-surface animate-cue-in" role="dialog" aria-modal="true" aria-label="Live grading">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <p className="font-heading text-[15px] font-bold">Live grading <span className="ml-1 text-[12px] font-normal text-ink-muted">Only you see this</span></p>
              <button ref={sheetClose} type="button" className="btn-quiet !min-h-[36px] !px-2" onClick={() => setSheet(false)} aria-label="Close coach"><X size={18} aria-hidden /></button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
              <CopilotRail scenario={scenario} result={coach.result} cues={coach.cues} mode={coachMode} onModeChange={onCoachModeChange} voice={isVoice}
                onUseLine={(c) => { onInsert(c); afterSheet.current = "composer"; setSheet(false); }} onDismiss={coach.dismiss} coachLabel={coachLabel} error={coach.error} onJump={jumpTo} />
            </div>
          </div>
        </div>
      )}

      <p className="sr-only" aria-live="assertive" aria-atomic="true">{announce}</p>

      {grading && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80" role="status">
          <div className="panel flex items-center gap-3 px-5 py-4">
            <Loader2 size={18} className="animate-spin text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Grading the full call</p>
              <p className="text-[12px] text-ink-muted">{gradingLabel}</p>
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

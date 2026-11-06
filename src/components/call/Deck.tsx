"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, PhoneOff, Send } from "lucide-react";
import type { CoachMode } from "@/lib/coach-types";
import { talkTrackSteps, type Scenario } from "@/lib/scenarios";
import type { StoredTurn } from "@/lib/sessionStore";
import { formatDuration } from "@/lib/format";
import { NEXT_CALL_STANDARD_NOTICE, TRIAL_CALL_NOTICE, liveCallLimitNotice, voiceLabel, type UsageSnapshot } from "@/lib/billingUi";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import CallError from "./CallError";
import MinutesLeft from "./MinutesLeft";
import { BlindNote, BuyerBrief, CoachSettings, EarlierCues, Instruments, NextMove, RubricMeters, TalkTrackPanel } from "./CopilotRail";
import { CALL_HEADLINE, callErrorText, nextMoveCue } from "./callCopy";
import type { LiveCue, RubricChip, useCoach } from "./useCoach";

export interface DeckText {
  value: string; onChange: (v: string) => void; onSend: () => void; hungUp: boolean; typing: boolean;
  /** Who plays the persona: "Text · AI" or "Text · scripted". Never a model id. */
  caller?: string;
}
export interface DeckVoice {
  muted: boolean; onToggleMute: () => void;
  /** Voice tier this call was minted on (the effective tier, not the request). A label only; never a model id. */
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

const clock = (iso: string | undefined, start: number) => (iso ? formatDuration(Math.max(0, Math.round((Date.parse(iso) - start) / 1000))) : "");
const DOT = { ok: "bg-ok", signal: "bg-signal", caution: "bg-caution" } as const;
/** Space mutes only when focus is not on something Space already operates. */
const SPACE_OWNERS = "input, textarea, select, button, a, summary, [role='radio'], [contenteditable='true']";

/**
 * The live call screen, "Buyer and brief". The transcript is the primary pane (about two thirds on wide screens) under
 * the heading "Stay with the buyer."; the rail holds the live scoreboard (overall estimate, labelled not final, and the
 * rubric meters), the buyer brief and exactly one next move. Rep lines carry their score chips. On phones the overall
 * score sits in a strip in the header, always visible; the brief, rubric meters, talk track, earlier cues and coach mode
 * sit in one titled disclosure, the transcript keeps every turn (scroll back for earlier ones), and the next move docks
 * above the controls. The controls sit in a bar that never overlays the transcript and clears the home indicator.
 * Blind mode keeps its meaning from before: no live help, so no scoreboard.
 */
export default function Deck({ scenario, turns, startedAt, elapsed, status, grading, gradingLabel, onEnd, coach, coachMode, onCoachModeChange, coachLabel, text, voice, inserted, onInsert, usage = null, error, canUpgrade = true }: {
  /** Minutes left when this call started (from the briefing's /api/usage read). Null when minutes are not metered. */
  usage?: UsageSnapshot | null;
  error?: string;
  /** False for a Team pool member who is not an owner or manager: the cap message says to ask their admin, with no Upgrade link. */
  canUpgrade?: boolean;
  scenario: Scenario;
  turns: StoredTurn[];
  startedAt: number;
  elapsed: number;
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
  const firstName = persona.name.split(" ")[0] || persona.name;
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  /** The phone brief disclosure is open: the docked cue shrinks to one line so both fit above the controls. */
  const [briefOpen, setBriefOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const announced = useRef<string | null>(null);
  const steps = talkTrackSteps(scenario.callScript);
  const shown = coachMode === "coached" ? nextMoveCue(coach.cues) : undefined;
  const lastBuyer = turns.map((t) => t.role).lastIndexOf("assistant");
  const isVoice = !!voice;
  const scored = coachMode !== "blind";
  const chipsFor = (i: number): RubricChip[] => coach.chips[i] ?? [];

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, text?.typing]);

  // Esc asks before ending; Space toggles mute in voice mode (unless focus is on something Space already operates).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !grading) setConfirmEnd(true);
      const owner = e.target instanceof Element && e.target.closest(SPACE_OWNERS);
      if (e.key === " " && voice && !owner) { e.preventDefault(); voice.onToggleMute(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grading, voice]);

  // A new cue is read out once through one polite region that is always on the page. Focus never moves for a cue.
  const newest = coach.cues[0];
  useEffect(() => {
    if (!newest || newest.id === announced.current) return;
    announced.current = newest.id;
    if (newest.status === "active" && coachMode === "coached") setAnnounce(`Next move: ${newest.title.replace(/[.!?]$/, "")}.${newest.suggestedLine ? ` ${newest.suggestedLine}` : ""}`);
  }, [newest, coachMode]);

  /** "Use line" removes the card that had focus, so focus goes to the composer that now holds the line. Rep-initiated only. */
  function insertLine(cue: LiveCue) {
    onInsert(cue);
    if (text) requestAnimationFrame(() => replyRef.current?.focus());
  }

  function endClicked() {
    if (window.matchMedia("(max-width: 1023px)").matches) setConfirmEnd(true);
    else onEnd();
  }

  const endButton = (compact: boolean) => (
    <button type="button" className="btn-danger min-h-[48px] min-w-[48px] shrink-0 px-3 text-sm sm:px-5 sm:text-base" onClick={endClicked} disabled={grading}>
      <PhoneOff size={18} strokeWidth={1.75} className={compact ? "sm:hidden" : "hidden sm:block"} aria-hidden />
      <span className={compact ? "sr-only sm:not-sr-only" : ""}>End and grade</span>
    </button>
  );

  return (
    <div className="focus-strong fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] text-ink">
      <header className="shrink-0 border-b border-line">
        <div className="site-wrap flex flex-wrap items-end justify-between gap-x-8 gap-y-2 py-3 lg:py-5">
          <div className="min-w-0 max-w-full">
            <p className="hidden text-sm text-ink-soft sm:block">Practice call</p>
            <h1 className="truncate text-2xl font-bold leading-tight lg:text-[32px]">{persona.name}</h1>
            <p className="hidden text-sm text-ink-soft sm:block">{scenario.title}</p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm lg:justify-end">
            {/* Status changes are announced politely; the clock beside it is not a live region. */}
            <p role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 font-semibold text-ink">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status.tone]}`} aria-hidden />{status.label}
            </p>
            <p className="mono text-ink-soft"><span className="sr-only">Call time </span>{formatDuration(elapsed)}</p>
            {/* Static for the whole call: the voice never changes mid-call. Neutral tier names only. */}
            {voice?.tier && <span className="badge-tag">{voiceLabel(voice.tier)}</span>}
            {text && <span className="badge-tag">{text.caller ?? "Text practice"}</span>}
            {usage && (!voice || usage.remaining > 0) && (
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-ink-soft">
                {voice && <span>At call start:</span>}
                <MinutesLeft usage={usage} mode={voice ? "voice" : "text"} canUpgrade={canUpgrade} />
              </div>
            )}
          </div>
        </div>
        {/* Phones: the live score strip, outside the scrolling body so it stays visible for the whole call. */}
        {scored && (
          <section aria-label="Live score" data-score-strip="" className="site-wrap pb-3 lg:hidden">
            <Instruments result={coach.result} steps={steps} compact />
          </section>
        )}
        {/* The Premium cutoff or trial notice, announced once, politely. */}
        <p aria-live="polite" className="site-wrap text-sm text-ink-soft [&:not(:empty)]:pb-3">{liveVoiceNotice(voice)}</p>
      </header>

      {/*
        Phones: one column with one height budget between the header and the controls. The open brief scrolls inside a
        small cap, the docked cue shrinks to one line while the brief is open, and the transcript keeps a minimum height.
        If a very short screen (or 200% zoom) still runs out of room, this column scrolls as a whole; nothing in it can
        spill over the controls, which sit outside it. Wide screens: two columns that scroll on their own.
      */}
      <div data-call-body="" className="site-wrap flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-visible">
        <section aria-labelledby="call-headline" className="flex flex-1 flex-col pt-3 lg:min-h-0 lg:py-6 lg:pr-10">
          <h2 id="call-headline" className="text-lg font-bold lg:text-xl">{CALL_HEADLINE}</h2>

          {/* Phones: the brief and the coach history live in one titled disclosure. */}
          <details data-phone-brief="" className="mt-2 shrink-0 rounded-panel border border-line lg:hidden" onToggle={(e) => setBriefOpen(e.currentTarget.open)}>
            <summary className="min-h-[48px] cursor-pointer px-3 py-3 text-[15px] font-semibold">Buyer brief, rubric and coach settings</summary>
            <div className="scroll-thin max-h-[min(25dvh,14rem)] space-y-5 overflow-y-auto border-t border-line p-3">
              <BuyerBrief scenario={scenario} idPrefix="phone" titleHidden />
              {scored && <RubricMeters scenario={scenario} result={coach.result} idPrefix="phone" />}
              {coachMode === "blind" ? <BlindNote /> : <TalkTrackPanel steps={steps} result={coach.result} open={coachMode === "guided"} />}
              {coachMode === "coached" && <EarlierCues cues={coach.cues} shownId={shown?.id} />}
              <CoachSettings mode={coachMode} onModeChange={onCoachModeChange} coachLabel={coachLabel} />
            </div>
          </details>

          {/* Every turn stays in this scroller, so earlier turns are always reachable by scrolling or keyboard. */}
          <div ref={logRef} role="region" aria-label="Conversation" tabIndex={0}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            className="scroll-thin mt-2 min-h-[6rem] flex-1 overflow-y-auto py-2 lg:mt-4">
            <ol aria-live="polite" className="space-y-1">
              {turns.length === 0 && !text?.typing && (
                <li className="py-10 text-center text-base text-ink-soft">{isVoice ? "Connecting the call. Say hello when you hear them." : "The transcript appears here as you talk."}</li>
              )}
              {turns.map((t, i) => {
                const me = t.role === "user";
                return (
                  <li key={i} data-turn="" className={`grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 rounded-panel px-3 py-3 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-5 sm:px-4 ${i === lastBuyer ? "bg-sunken" : ""}`}>
                    <div className="min-w-0 text-sm leading-5">
                      <p className="break-words font-semibold text-ink">{me ? "You" : firstName}</p>
                      {t.timestamp && <p className="mono text-ink-soft">{clock(t.timestamp, startedAt)}</p>}
                    </div>
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap break-words text-[18px] leading-7 text-ink lg:text-[20px] lg:leading-[31px]">{t.text}</p>
                      {me && chipsFor(i).length > 0 && (
                        <div data-score-chips="" className="mt-1.5 flex flex-wrap gap-1.5">
                          {chipsFor(i).map((c) => <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-ok-soft px-1.5 py-0.5 font-mono text-[11px] text-ok">▲ {c.name} +{c.delta}</span>)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {text?.typing && (
                // The header status already says who is typing; the dots are decoration.
                <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-3 py-3 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-5 sm:px-4" aria-hidden>
                  <span />
                  <span className="flex items-center gap-1.5 py-2">
                    {[0, 150, 300].map((d) => <span key={d} className="h-1.5 w-1.5 rounded-full bg-ink-soft motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
                  </span>
                </li>
              )}
            </ol>
          </div>
        </section>

        {/*
          Wide screens: the rail. The overall estimate is pinned at the top, outside the rail's scroller, so it stays
          visible while the meters, brief, next move and settings scroll beneath it. Phones: only the one next move,
          docked above the controls (the phone score strip is in the header).
        */}
        <aside aria-label="Buyer brief and coaching" className="scroll-thin -mx-2 max-h-[min(30dvh,12rem)] shrink-0 overflow-y-auto px-2 pb-3 lg:mx-0 lg:flex lg:min-h-0 lg:max-h-none lg:flex-col lg:overflow-visible lg:border-l lg:border-line lg:py-6 lg:pl-8 lg:pr-2">
          {scored && (
            <section aria-label="Live instruments" data-score-pinned="" className="hidden shrink-0 border-b border-line pb-5 lg:block">
              <Instruments result={coach.result} steps={steps} />
            </section>
          )}
          <div data-rail-scroll="" className="scroll-thin lg:-mx-2 lg:min-h-0 lg:flex-1 lg:space-y-6 lg:overflow-y-auto lg:px-2 lg:pt-5">
          <div className="hidden space-y-6 lg:block">
            {scored && <RubricMeters scenario={scenario} result={coach.result} idPrefix="rail" />}
            <BuyerBrief scenario={scenario} idPrefix="rail" />
          </div>
          {coachMode === "coached" && (
            <NextMove cue={shown} voice={isVoice} compact={briefOpen} onUse={() => shown && insertLine(shown)} onDismiss={() => shown && coach.dismiss(shown.id)} />
          )}
          {coach.error && coachMode !== "blind" && <p role="status" className="mt-2 text-sm text-ink-soft lg:mt-0">{coach.error}</p>}
          <div className="hidden space-y-6 lg:block">
            {coachMode === "blind" ? <BlindNote /> : <TalkTrackPanel steps={steps} result={coach.result} open={coachMode === "guided"} />}
            {coachMode === "coached" && <EarlierCues cues={coach.cues} shownId={shown?.id} />}
            <CoachSettings mode={coachMode} onModeChange={onCoachModeChange} coachLabel={coachLabel} />
          </div>
          </div>
        </aside>
      </div>

      {/* Call controls: a bar in the page flow (never over the transcript), 48 px targets, clear of the home indicator. */}
      <section aria-label="Call controls" className="shrink-0 border-t border-line bg-background">
        <div className="site-wrap pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          {error && <CallError message={callErrorText(error)} className="mb-3" canUpgrade={canUpgrade} />}
          {text?.hungUp && (
            <div role="status" className="flex flex-col gap-3 rounded-panel border border-line bg-caution-soft p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm"><strong>{persona.name} hung up.</strong> The call is over.</p>
              <button type="button" className="btn-primary btn-lg" onClick={onEnd} disabled={grading}>Grade this call</button>
            </div>
          )}
          {text && !text.hungUp && (
            <div className="space-y-2">
              {inserted && <p className="text-sm text-ink-soft">Line inserted from the coach. Edit it or send it. Nothing is sent on its own.</p>}
              <div className="flex items-end gap-2 sm:gap-3">
                <form className="flex min-w-0 flex-1 items-end gap-2 sm:gap-3" onSubmit={(e) => { e.preventDefault(); text.onSend(); }}>
                  <textarea
                    ref={replyRef}
                    className="input min-h-[48px] min-w-0 resize-none py-3 text-base leading-snug"
                    rows={inserted ? 3 : 1}
                    value={grading ? "" : text.value}
                    onChange={(e) => text.onChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); text.onSend(); } }}
                    placeholder={grading ? "Grading" : "Type what you would say"}
                    aria-label="Your reply"
                    autoFocus
                    disabled={grading}
                  />
                  <button type="submit" className="btn-primary min-h-[48px] min-w-[48px] shrink-0 px-3" disabled={grading || !text.value.trim()} aria-label="Send">
                    <Send size={18} strokeWidth={1.75} aria-hidden />
                  </button>
                </form>
                {endButton(true)}
              </div>
              <p className="hidden text-xs text-ink-soft sm:block"><span className="kbd">Enter</span> sends · <span className="kbd">Shift</span>+<span className="kbd">Enter</span> adds a line · <span className="kbd">Esc</span> ends the call</p>
            </div>
          )}
          {voice && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="hidden text-xs text-ink-soft lg:block"><span className="kbd">Space</span> mutes · <span className="kbd">Esc</span> ends the call</p>
              <div className="grid w-full grid-cols-2 gap-3 sm:ml-auto sm:flex sm:w-auto">
                <button type="button" className={`btn-ghost min-h-[48px] px-3 text-sm sm:px-5 sm:text-base ${voice.muted ? "!border-alert !text-alert" : ""}`} onClick={voice.onToggleMute} disabled={grading}>
                  {voice.muted ? <MicOff size={18} strokeWidth={1.75} aria-hidden /> : <Mic size={18} strokeWidth={1.75} aria-hidden />}
                  <span>{voice.muted ? "Unmute" : "Mute"}<span className="hidden sm:inline"> microphone</span></span>
                </button>
                {endButton(false)}
              </div>
            </div>
          )}
        </div>
      </section>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>

      {grading && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/90 p-4">
          <div role="status" className="panel flex items-center gap-3 px-5 py-4">
            <Loader2 size={20} strokeWidth={1.75} className="shrink-0 text-primary motion-safe:animate-spin" aria-hidden />
            <div>
              <p className="text-base font-semibold">Grading the full call</p>
              <p className="text-sm text-ink-soft">{gradingLabel}</p>
            </div>
          </div>
        </div>
      )}

      {confirmEnd && (
        <ConfirmDialog title="End the call and grade it?" message="You'll get a full debrief with scores, evidence and a retry point." confirmLabel="End and grade"
          onConfirm={() => { setConfirmEnd(false); onEnd(); }} onCancel={() => setConfirmEnd(false)} />
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Keyboard, Mic, PhoneCall, RotateCcw, ShieldAlert } from "lucide-react";
import { COACH_MODE_LABELS, type CoachMode } from "@/lib/coach-types";
import { CALL_TYPE_LABELS, OBJECTION_LABELS, jobFamilyLabel, talkTrackSteps, type Scenario } from "@/lib/scenarios";
import { VOICE_ENGINE_LABELS, averageLevel, micErrorMessage, type VoiceEngine } from "@/lib/realtime";
import type { Capabilities } from "@/contexts/AuthContext";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import { isCapMessage, premiumCallLimitMinutes, premiumCallLimitNotice, premiumChoiceAvailable, premiumLeftLabel, voiceLabel, type PremiumSnapshot, type UsageSnapshot, type VoiceChoice } from "@/lib/billingUi";
import CallError from "./CallError";
import MinutesLeft from "./MinutesLeft";
import PremiumMinutes from "./PremiumMinutes";
import VoiceUnavailable, { VOICE_UNAVAILABLE_ID } from "./VoiceUnavailable";
import { ModeDial, radioKeys } from "./CopilotRail";

const MODE_HELP: Record<CoachMode, string> = {
  blind: "No live help. Pure practice, full debrief at the end.",
  guided: "Live estimate and talk-track progress, no cues.",
  coached: "Everything, plus cues when an objection lands or a step is due.",
};

type LampState = "ok" | "caution" | "off";

/** Categorical criterion hue (--cat-1 to --cat-8), in the same order the Library strip and the Debrief use. */
const critHue = (i: number) => `rgb(var(--cat-${(i % 8) + 1}))`;

function Lamp({ state, label, detail }: { state: LampState; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span className={`lamp mt-1.5 lamp-${state}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label} <span className="sr-only">({state === "ok" ? "ready" : state === "caution" ? "limited" : "off"})</span></p>
        <p className="text-xs text-ink-muted">{detail}</p>
      </div>
    </li>
  );
}

/**
 * Offset and padding for the phone Start call bar. /trainer is signed-in only, so below md the fixed bottom tab bar
 * (MobileTabBar: 56 px plus the safe-area inset) is always on screen. A bar at bottom: 0 would sit under it, so this one
 * sticks right above it: 3.5rem plus env(safe-area-inset-bottom). The tab bar already pads the home indicator area.
 */
export const STICKY_START_BAR = "bottom-[calc(3.5rem+env(safe-area-inset-bottom))] pb-3";

type MicResult = "ok" | "quiet" | "blocked";
const CALL_MODES = ["voice", "text"] as const;
const MIC_TEST_MS = 5000;

/** Opens the mic only when clicked, shows a live level for about 5 seconds, then stops every track. */
function MicCheck({ onResult }: { onResult: (r: MicResult) => void }) {
  const [state, setState] = useState<"idle" | "asking" | "live" | "done">("idle");
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState("");
  const stopRef = useRef<() => void>(() => {});
  // The permission prompt doesn't block the page: the rep can start the call before answering it.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; stopRef.current(); };
  }, []);
  const busy = state === "asking" || state === "live";

  async function run() {
    if (busy) return;
    setState("asking");
    setNote("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (!aliveRef.current) return;
      setState("done");
      setNote(micErrorMessage(e));
      onResult("blocked");
      return;
    }
    // Unmounted while the browser asked: release the mic at once and open nothing else.
    if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
    let ctx: AudioContext | null = null;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer); // declared below; stop only runs once the timer exists
      stream.getTracks().forEach((t) => t.stop());
      if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
      stopRef.current = () => {};
    };
    stopRef.current = stop;
    let peak = 0;
    try {
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(an);
      const bins = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(bins);
        const v = averageLevel(bins);
        peak = Math.max(peak, v);
        setLevel(v);
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      peak = 1; // no WebAudio: the mic still opened, which is the useful answer
    }
    setState("live");
    const timer = setTimeout(() => {
      stop();
      setLevel(0);
      setState("done");
      const heard = peak > 0.04;
      setNote(heard ? "Your mic is working." : "We barely heard you. Check that the right mic is selected and not muted, then test again.");
      onResult(heard ? "ok" : "quiet");
    }, MIC_TEST_MS);
  }

  const pct = Math.min(100, Math.round(level * 300));
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-3">
        {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the page for the whole test. */}
        <button type="button" className="btn-ghost btn-sm shrink-0" onClick={run} aria-disabled={busy}>
          <Mic size={14} strokeWidth={1.75} aria-hidden />{state === "live" ? "Listening…" : state === "done" ? "Test again" : "Test mic"}
        </button>
        <div className="tape min-w-0 flex-1" role="meter" aria-label="Mic level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className="bg-ok !transition-none" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="text-xs text-ink-muted" role="status">
        {state === "asking" ? "Allow the mic when your browser asks." : state === "live" ? "Say a few words. The meter should move." : note || "Checks your mic for 5 seconds. Nothing is recorded or sent."}
      </p>
    </div>
  );
}

/**
 * Standard or Premium for this call, for anyone who can run Premium now (Prism finding 1). Premium is the default; a
 * rep may pick Standard to save Premium minutes. Native fieldset, legend and radio inputs, so arrow keys move the
 * single selection and a screen reader hears the group name and the choice.
 * Pattern reference (semantics only, not visuals): Calm's language setting, a single-choice list of labeled rows with
 * one visible selected marker, https://mobbin.com/screens/5a84112e-6cb6-404b-87c1-f484abd4f561 . Drawn with the app's
 * own tokens; no new icons.
 * The pick is a request: the server rechecks the entitlement at mint, so Premium without one is still Standard.
 */
export function VoiceChoiceField({ premium, usage, value, onChange }: { premium: PremiumSnapshot; usage: UsageSnapshot | null; value: VoiceChoice; onChange: (c: VoiceChoice) => void }) {
  const limit = value === "premium" && !premium.comped && premium.enabled ? premiumCallLimitMinutes(premium.remaining, usage?.remaining ?? Number.POSITIVE_INFINITY) : null;
  const options: { id: VoiceChoice; hint: string }[] = [
    { id: "premium", hint: premium.comped ? "Included for your team" : premiumLeftLabel(premium) },
    { id: "standard", hint: "Saves your Premium minutes" },
  ];
  return (
    <fieldset className="min-w-0 space-y-1">
      <legend className="label">Voice for this call</legend>
      {options.map((o) => (
        <label key={o.id} className="flex min-h-[38px] cursor-pointer flex-wrap items-center gap-x-2 rounded-md px-2 py-1 text-sm hover:bg-sunken">
          <input type="radio" name="voice-choice" value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} className="h-4 w-4 shrink-0 accent-[rgb(var(--primary))]" />
          <span className="font-medium">{voiceLabel(o.id)}</span>
          <span className="min-w-0 text-xs text-ink-muted">{o.hint}</span>
        </label>
      ))}
      {/* Prism finding 2: when the Premium minutes are what will end THIS call, say so before it starts. */}
      <p role="status" aria-live="polite" className="text-xs text-ink-soft">{limit != null ? premiumCallLimitNotice(limit) : ""}</p>
    </fieldset>
  );
}

export default function Briefing({ scenario, capabilities, mode, onModeChange, onUseText, engine, onEngineChange, coachMode, onCoachModeChange, onStart, retryFrom, error, notice, usage, canUpgrade = true, usageUnavailable, premium, voiceChoice = "premium", onVoiceChoiceChange }: {
  /** Premium minutes left, or the locked Add Premium voice / Ask your admin state. Null when not metered. */
  premium?: PremiumSnapshot | null;
  /** Standard or Premium for this call, shown only when Premium can run (premiumChoiceAvailable). */
  voiceChoice?: VoiceChoice;
  onVoiceChoiceChange?: (c: VoiceChoice) => void;
  scenario: Scenario;
  capabilities: Capabilities;
  mode: "voice" | "text";
  onModeChange: (m: "voice" | "text") => void;
  /** Switch to Text because voice cannot run now (no minutes, lookup failed). Not a saved preference. Defaults to onModeChange. */
  onUseText?: () => void;
  /** Chosen voice engine; null when the server has none. */
  engine: VoiceEngine | null;
  onEngineChange: (e: VoiceEngine) => void;
  coachMode: CoachMode;
  onCoachModeChange: (m: CoachMode) => void;
  onStart: () => void;
  retryFrom?: { turn: number; line: string } | null;
  error?: string;
  /** Shown when the link named a persona this browser doesn't have and another one opened instead. */
  notice?: string;
  /** Voice minutes left and the plan's minutes this period; null or undefined when minutes are not metered (demo mode, no billing). */
  usage?: UsageSnapshot | null;
  /** False for a Team pool member who is not an owner or manager: they are told to ask their admin, with no Upgrade link. */
  canUpgrade?: boolean;
  /** True when the usage lookup failed on a stored account: voice is blocked (fail closed), text stays open. */
  usageUnavailable?: boolean;
}) {
  const p = scenario.aiPersona;
  const steps = talkTrackSteps(scenario.callScript);
  const total = scenario.rubric.reduce((a, c) => a + c.weight, 0) || 1;
  const [goalRead, setGoalRead] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [mic, setMic] = useState<MicResult | null>(null);
  /** The prep answer just revealed takes focus, because the button that revealed it is gone. */
  const focusPrep = useRef<number | null>(null);
  const engines = capabilities.voiceEngines ?? (capabilities.elevenlabs ? ["elevenlabs" as const] : []);
  const voiceReady = !!engine && engines.includes(engine);
  const blocked = mode === "voice" && !voiceReady;
  const voiceLookupFailed = mode === "voice" && !!usageUnavailable;
  const switchToText = onUseText ?? (() => onModeChange("text"));
  const outOfMinutes = mode === "voice" && !!usage && usage.remaining <= 0;
  const voiceDetail = !voiceReady ? "Voice isn't configured on this server."
    : engine === "openai" ? "OpenAI Realtime over WebRTC. Your browser asks for the mic when the call starts."
    : "ElevenLabs Agents over WebRTC. Your browser asks for the mic when the call starts.";
  const startDisabled = blocked || voiceLookupFailed || outOfMinutes;
  const lamps: { key: string; state: LampState; label: string; detail: string }[] = [
    { key: "persona", state: "ok", label: "Persona loaded", detail: `${p.name} stays in character and never coaches you.` },
    { key: "goal", state: goalRead ? "ok" : "off", label: "Goal read", detail: goalRead ? "You know what a win looks like." : "Tick “Got it” once you've read your goal." },
    { key: "coach", state: capabilities.llm ? "ok" : "caution", label: "Coach", detail: capabilities.llm ? "AI coach is on for this call." : "Rules-based coach. Add an AI key for smarter cues and grading." },
    {
      key: "channel",
      state: mode === "text" ? "ok" : voiceLookupFailed ? "off" : voiceReady ? "ok" : "caution",
      label: mode === "voice" ? (voiceReady && engine && !voiceLookupFailed ? `Voice · ${VOICE_ENGINE_LABELS[engine]}` : "Voice") : "Text simulation",
      detail: mode === "voice" ? (voiceLookupFailed ? "Voice is unavailable right now. Text practice still works." : voiceDetail) : capabilities.llm ? "Type your side; the caller replies in seconds." : "Scripted caller replies (no AI key).",
    },
    ...(mode === "voice" && voiceReady ? [{
      key: "mic", state: (mic === "ok" ? "ok" : mic ? "caution" : "off") as LampState, label: "Mic",
      detail: mic === "ok" ? "Your mic is picking you up." : mic === "quiet" ? "Very low level. Check your input device." : mic === "blocked" ? "The browser blocked the mic. Allow it to use voice." : "Optional: run a mic test below.",
    }] : []),
  ];
  const readyCount = lamps.filter((l) => l.state === "ok").length;
  /** Every visible lamp is green and nothing blocks the call: Start picks up the signal glow. */
  const allClear = readyCount === lamps.length && !startDisabled;

  // Rendered once in the card (sm and up) and once in the phone sticky bar; only one is displayed at any width, so the
  // hidden copy is out of the accessibility tree and the describedby targets stay unique in practice.
  const startButton = (
    /* A disabled Start always has a visible reason, and aria-describedby points the button at it. */
    <button className={`btn-primary btn-xl w-full ${allClear ? "shadow-glow" : ""}`} onClick={onStart} disabled={startDisabled}
      aria-describedby={voiceLookupFailed ? VOICE_UNAVAILABLE_ID : outOfMinutes ? "minutes-out" : blocked ? "voice-blocked-reason" : undefined}>
      <PhoneCall size={18} strokeWidth={1.75} aria-hidden /> Start call
    </button>
  );
  const industry = scenario.industry && scenario.industry.toLowerCase() !== jobFamilyLabel(scenario.role).toLowerCase() ? scenario.industry : null;

  return (
    <div className="page enter pb-0 sm:pb-10">
      <Link href="/library" className="inline-flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> Library</Link>

      <div className="mt-2 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="min-w-0 space-y-8">
          <header className="flex items-start gap-4 sm:gap-5">
            <PersonaAvatar scenario={scenario} size={64} className="mt-1" />
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Pre-flight briefing</p>
              <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{p.name}</h1>
              <p className="mt-0.5 text-sm text-ink-soft">{p.role}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-soft">
                <span>{jobFamilyLabel(scenario.role)}</span>
                <span className="h-3 w-px bg-line" aria-hidden />
                <span>{CALL_TYPE_LABELS[scenario.callType]}</span>
                {industry && <><span className="h-3 w-px bg-line" aria-hidden /><span>{industry}</span></>}
                <span className="h-3 w-px bg-line" aria-hidden />
                <DifficultyBars level={scenario.difficulty} />
                <span className="font-mono text-[11px] text-ink-muted">~{scenario.durationMin} min</span>
                {scenario.status === "draft" && scenario.builtIn && <span className="chip !border-caution/40 !text-caution">Draft persona</span>}
              </div>
            </div>
          </header>

          {notice && <p className="banner-warn" role="status">{notice} <Link href="/library" className="font-semibold underline underline-offset-2">Open the Library</Link></p>}

          {retryFrom && (
            <p id="retry-reason" className="banner-info flex items-start gap-2 !border-primary/40" role="status">
              <RotateCcw size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              <span><strong>Retry from turn {retryFrom.turn}.</strong> The call picks up right after {p.name} says &ldquo;{retryFrom.line}&rdquo; Retries run in text mode.</span>
            </p>
          )}

          {/* The goal is the one thing to carry into the call, so it leads, set larger than everything around it. */}
          <section aria-labelledby="goal-h" className="rounded-panel border border-l-4 border-primary/30 border-l-primary bg-primary-soft/40 p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h2 id="goal-h" className="label !mb-0 !text-primary">Your goal</h2>
              <label className="-my-2 flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 text-sm font-medium text-ink-soft">
                <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={goalRead} onChange={(e) => setGoalRead(e.target.checked)} /> Got it
              </label>
            </div>
            <p className="mt-2 max-w-[60ch] font-heading text-lg font-semibold leading-snug text-ink sm:text-xl">{scenario.traineeGoal}</p>
          </section>

          <section className="card" aria-labelledby="rubric-h">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="rubric-h" className="label !mb-0">Success criteria · how you&rsquo;re graded</h2>
              <span className="font-mono text-[11px] text-ink-muted">{scenario.rubric.length} criteria</span>
            </div>
            <ul className="mt-2 divide-y divide-line">
              {scenario.rubric.map((c, i) => {
                const pct = Math.round((c.weight / total) * 100);
                const hue = critHue(i);
                return (
                  <li key={c.id} className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hue }} aria-hidden />{c.name}</p>
                        {c.description && <p className="mt-0.5 pl-4 text-xs text-ink-muted">{c.description}</p>}
                      </div>
                      <span className="mono shrink-0 text-sm text-ink-soft">{pct}%</span>
                    </div>
                    <div className="tape ml-4 mt-2" aria-hidden><span style={{ width: `${pct}%`, background: hue }} /></div>
                  </li>
                );
              })}
            </ul>
          </section>

          {scenario.objections.length > 0 && (
            <section aria-labelledby="obj-h">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="obj-h" className="label !mb-0">Expect these objections</h2>
                <span className="text-xs text-ink-muted">The coach cues you when one lands.</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {scenario.objections.map((o, i) => (
                  <article key={i} className="rounded-panel border-l-2 border-alert/60 bg-sunken p-3.5 shadow-inner-top">
                    <div className="flex items-start gap-2">
                      <ShieldAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">{OBJECTION_LABELS[o.type]}</p>
                        <p className="mt-0.5 text-sm font-semibold text-ink">&ldquo;{o.line}&rdquo;</p>
                      </div>
                    </div>
                    {o.prepAnswer && (revealed.has(i) ? (
                      <div tabIndex={-1} className="mt-2.5 rounded-md border border-dashed border-line bg-surface p-2.5 outline-none focus-visible:outline-2"
                        ref={(el) => { if (el && focusPrep.current === i) { focusPrep.current = null; el.focus(); } }}>
                        <p className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">Prep answer</p>
                        <p className="mt-0.5 text-[13px] text-ink">{o.prepAnswer}</p>
                      </div>
                    ) : (
                      <button type="button" className="btn-quiet btn-sm mt-2 !min-h-[40px] !px-2 !text-primary" onClick={() => { focusPrep.current = i; setRevealed((r) => new Set(r).add(i)); }}>
                        <Eye size={14} strokeWidth={1.75} aria-hidden /> Think first, then show a prep answer
                      </button>
                    ))}
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="track-h">
            <h2 id="track-h" className="label">Talk track · ticks live during the call</h2>
            <ol className="relative mt-3 space-y-3 pl-8 before:absolute before:bottom-2 before:left-[10px] before:top-2 before:w-px before:bg-line">
              {steps.map((s, i) => (
                <li key={i} className="relative text-sm leading-relaxed">
                  <span className="absolute -left-8 top-0.5 flex h-[21px] w-[21px] items-center justify-center rounded-full border border-line bg-surface font-mono text-[10px] text-ink-muted">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-[calc(var(--header-h,3.5rem)+1.5rem)]" aria-label="Systems check and call setup">
          {/* The cockpit: a dark deck panel, so the lamps genuinely glow beside the daylight briefing. */}
          <div className="deck space-y-5 rounded-sheet border border-line p-5 shadow-pop">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="label !mb-0">Systems check</p>
                <span className="chip-model"><span className={`lamp ${allClear ? "lamp-ok" : "lamp-caution"} !h-1.5 !w-1.5`} aria-hidden />{readyCount} of {lamps.length} ready</span>
              </div>
              <ul className="mt-2 divide-y divide-line">
                {lamps.map((l) => <Lamp key={l.key} state={l.state} label={l.label} detail={l.detail} />)}
              </ul>
            </div>

            <div className="border-t border-line pt-5">
              <p className="label">Call mode</p>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1 ring-1 ring-line" role="radiogroup" aria-label="Call mode" onKeyDown={radioKeys(CALL_MODES, mode, onModeChange, (m) => !!retryFrom && m === "voice")}>
                {CALL_MODES.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} disabled={!!retryFrom && m === "voice"} aria-describedby={!!retryFrom && m === "voice" ? "retry-reason" : undefined} onClick={() => onModeChange(m)}
                    className={`flex min-h-[40px] items-center justify-center gap-2 rounded-md text-sm font-semibold transition disabled:opacity-40 ${mode === m ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
                    {m === "voice" ? <Mic size={15} strokeWidth={1.75} aria-hidden /> : <Keyboard size={15} strokeWidth={1.75} aria-hidden />}{m === "voice" ? "Voice" : "Text"}
                  </button>
                ))}
              </div>
              {blocked && <p id="voice-blocked-reason" className="mt-2 text-xs text-caution">Voice calls need an OpenAI key or ElevenLabs keys on the server. Switch to Text to practice now.</p>}
              {mode === "voice" && voiceReady && engines.length > 1 && (
                <div className="mt-3">
                  <p className="label">Voice engine</p>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1 ring-1 ring-line" role="radiogroup" aria-label="Voice engine" onKeyDown={radioKeys(engines, engine ?? engines[0], onEngineChange)}>
                    {engines.map((e) => (
                      <button key={e} type="button" role="radio" aria-checked={engine === e} tabIndex={engine === e ? 0 : -1} onClick={() => onEngineChange(e)}
                        className={`min-h-[36px] rounded-md px-2 text-xs font-semibold transition ${engine === e ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
                        {VOICE_ENGINE_LABELS[e]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {mode === "voice" && voiceReady && <MicCheck onResult={setMic} />}
            </div>

            <div>
              <p className="label">Coach mode · {COACH_MODE_LABELS[coachMode]}</p>
              <ModeDial mode={coachMode} onChange={onCoachModeChange} />
              <p className="mt-2 text-xs text-ink-muted">{MODE_HELP[coachMode]}</p>
            </div>

            {/* A cap refusal while the usage panel shows no minutes left is not repeated: the panel has the count, the reset date and the right Upgrade link. */}
            {error && !(outOfMinutes && isCapMessage(error)) && <CallError message={error} canUpgrade={canUpgrade} />}

            {/* Minutes near Start, in every state: voice keys set up or not. */}
            <MinutesLeft usage={usage ?? null} mode={mode} canUpgrade={canUpgrade} />
            {mode === "voice" && <PremiumMinutes premium={premium ?? null} />}
            {mode === "voice" && premium && premiumChoiceAvailable(premium) && onVoiceChoiceChange && (
              <VoiceChoiceField premium={premium} usage={usage ?? null} value={voiceChoice} onChange={onVoiceChoiceChange} />
            )}

            {voiceLookupFailed && <VoiceUnavailable onUseText={switchToText} />}
            {outOfMinutes && !voiceLookupFailed && <button type="button" className="btn-ghost btn-sm w-full" onClick={switchToText}>Switch to text practice</button>}

            {/* From sm up Start sits here in the card. Below sm the same button lives in the sticky bar at the end of the page. */}
            <div className="hidden sm:block">{startButton}</div>
            <p className="text-center text-xs text-ink-muted">The coach only talks to you. {p.name} never hears it.</p>
          </div>
          <Link href="/library" className="btn-ghost w-full">Change persona</Link>
        </aside>
      </div>

      {/* Phones: Start call stays on screen as a sticky bottom action bar (STICKY_START_BAR). The page drops its own bottom
          padding below sm, so the bar sits flush with the tab bar when scrolled to the end. */}
      <div className={`sticky z-30 -mx-4 mt-8 border-t border-line bg-surface px-4 pt-3 sm:hidden ${STICKY_START_BAR}`}>
        {startButton}
      </div>
    </div>
  );
}

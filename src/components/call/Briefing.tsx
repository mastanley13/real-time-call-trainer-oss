"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Keyboard, Mic, PhoneCall, RotateCcw } from "lucide-react";
import { COACH_MODE_LABELS, type CoachMode } from "@/lib/coach-types";
import { CALL_TYPE_LABELS, OBJECTION_LABELS, jobFamilyLabel, talkTrackSteps, type Scenario } from "@/lib/scenarios";
import { VOICE_ENGINE_LABELS, averageLevel, micErrorMessage, type VoiceEngine } from "@/lib/realtime";
import type { Capabilities } from "@/contexts/AuthContext";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import { ModeDial, radioKeys } from "./CopilotRail";

const MODE_HELP: Record<CoachMode, string> = {
  blind: "No live help. Pure practice, full debrief at the end.",
  guided: "Live estimate and talk-track progress, no cues.",
  coached: "Everything, plus cues when an objection lands or a step is due.",
};

function Lamp({ state, label, detail }: { state: "ok" | "caution" | "off"; label: string; detail: string }) {
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

export default function Briefing({ scenario, capabilities, mode, onModeChange, engine, onEngineChange, coachMode, onCoachModeChange, onStart, retryFrom, error, notice }: {
  scenario: Scenario;
  capabilities: Capabilities;
  mode: "voice" | "text";
  onModeChange: (m: "voice" | "text") => void;
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
  const voiceDetail = !voiceReady ? "Voice isn't configured on this server."
    : engine === "openai" ? `${capabilities.realtimeModel ?? "OpenAI Realtime"} over WebRTC. Your browser asks for the mic when the call starts.`
    : "ElevenLabs Agents over WebRTC. Your browser asks for the mic when the call starts.";

  return (
    <div className="page enter">
      <Link href="/library" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink"><ArrowLeft size={15} aria-hidden /> Library</Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="space-y-6">
          <header className="card flex flex-col gap-5 sm:flex-row sm:items-center">
            <PersonaAvatar scenario={scenario} size={72} />
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Pre-flight briefing</p>
              <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{p.name}</h1>
              <p className="mt-0.5 text-sm text-ink-soft">{p.role}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="chip">{jobFamilyLabel(scenario.role)}</span>
                <span className="chip">{CALL_TYPE_LABELS[scenario.callType]}</span>
                {scenario.industry && scenario.industry.toLowerCase() !== jobFamilyLabel(scenario.role).toLowerCase() && <span className="chip">{scenario.industry}</span>}
                <DifficultyBars level={scenario.difficulty} />
                <span className="font-mono text-[11px] text-ink-muted">~{scenario.durationMin} min</span>
                {scenario.status === "draft" && scenario.builtIn && <span className="chip !border-caution/40 !text-caution">Draft persona</span>}
              </div>
            </div>
          </header>

          {notice && <p className="banner-warn" role="status">{notice} <Link href="/library" className="font-semibold underline underline-offset-2">Open the Library</Link></p>}

          {retryFrom && (
            <p className="flex items-start gap-2 rounded-panel border border-primary/40 bg-primary-soft/50 p-3 text-sm" role="status">
              <RotateCcw size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              <span><strong>Retry from turn {retryFrom.turn}.</strong> The call picks up right after {p.name} says &ldquo;{retryFrom.line}&rdquo; Retries run in text mode.</span>
            </p>
          )}

          <section className="card" aria-labelledby="goal-h">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="goal-h" className="label">Your goal</h2>
                <p className="text-base font-medium">{scenario.traineeGoal}</p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={goalRead} onChange={(e) => setGoalRead(e.target.checked)} /> Got it
              </label>
            </div>
            <h3 className="label mt-5">Success criteria · how you&rsquo;re graded</h3>
            <ul className="divide-y divide-line">
              {scenario.rubric.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{c.name}</p>
                    {c.description && <p className="text-xs text-ink-muted">{c.description}</p>}
                  </div>
                  <span className="mono shrink-0 text-sm text-ink-soft">{Math.round((c.weight / total) * 100)}%</span>
                </li>
              ))}
            </ul>
          </section>

          {scenario.objections.length > 0 && (
            <section aria-labelledby="obj-h">
              <h2 id="obj-h" className="label">Expect these objections</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {scenario.objections.map((o, i) => (
                  <div key={i} className="card !p-4">
                    <span className="chip !text-[11px]">{OBJECTION_LABELS[o.type]}</span>
                    <p className="mt-2 text-sm font-medium">&ldquo;{o.line}&rdquo;</p>
                    {o.prepAnswer && (revealed.has(i) ? (
                      <p tabIndex={-1} className="mt-2 text-sm text-ink-soft outline-none focus-visible:outline-2"
                        ref={(el) => { if (el && focusPrep.current === i) { focusPrep.current = null; el.focus(); } }}>
                        <span className="font-mono text-[11px] uppercase text-primary">Prep </span>{o.prepAnswer}
                      </p>
                    ) : (
                      <button type="button" className="mt-2 text-xs font-semibold text-primary hover:underline" onClick={() => { focusPrep.current = i; setRevealed((r) => new Set(r).add(i)); }}>Think first, then show a prep answer</button>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="track-h">
            <h2 id="track-h" className="label">Talk track · ticks live during the call</h2>
            <ol className="relative space-y-3 pl-7 before:absolute before:bottom-2 before:left-[9px] before:top-2 before:w-px before:bg-line">
              {steps.map((s, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-7 top-0 flex h-[19px] w-[19px] items-center justify-center rounded-full border border-line bg-surface font-mono text-[10px] text-ink-muted">{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h,3.5rem)+1.5rem)]">
          <div className="card space-y-5">
            <div>
              <p className="label">Systems check</p>
              <ul className="divide-y divide-line">
                <Lamp state="ok" label="Persona loaded" detail={`${p.name} stays in character and never coaches you.`} />
                <Lamp state={goalRead ? "ok" : "off"} label="Goal read" detail={goalRead ? "You know what a win looks like." : "Tick “Got it” once you've read your goal."} />
                <Lamp state={capabilities.llm ? "ok" : "caution"} label="Coach" detail={capabilities.llm ? `AI coach on ${capabilities.model ?? "your model"}` : "Rules-based coach. Add an AI key for smarter cues and grading."} />
                <Lamp state={mode === "text" ? "ok" : voiceReady ? "ok" : "caution"} label={mode === "voice" ? (voiceReady && engine ? `Voice · ${VOICE_ENGINE_LABELS[engine]}` : "Voice") : "Text simulation"} detail={mode === "voice" ? voiceDetail : capabilities.llm ? "Type your side; the caller replies in seconds." : "Scripted caller replies (no AI key)."} />
                {mode === "voice" && voiceReady && (
                  <Lamp state={mic === "ok" ? "ok" : mic ? "caution" : "off"} label="Mic"
                    detail={mic === "ok" ? "Your mic is picking you up." : mic === "quiet" ? "Very low level. Check your input device." : mic === "blocked" ? "The browser blocked the mic. Allow it to use voice." : "Optional: run a mic test below."} />
                )}
              </ul>
            </div>

            <div>
              <p className="label">Call mode</p>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1" role="radiogroup" aria-label="Call mode" onKeyDown={radioKeys(CALL_MODES, mode, onModeChange, (m) => !!retryFrom && m === "voice")}>
                {CALL_MODES.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} tabIndex={mode === m ? 0 : -1} disabled={!!retryFrom && m === "voice"} onClick={() => onModeChange(m)}
                    className={`flex min-h-[38px] items-center justify-center gap-2 rounded-md text-sm font-semibold transition disabled:opacity-40 ${mode === m ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
                    {m === "voice" ? <Mic size={15} aria-hidden /> : <Keyboard size={15} aria-hidden />}{m === "voice" ? "Voice" : "Text"}
                  </button>
                ))}
              </div>
              {blocked && <p className="mt-2 text-xs text-caution">Voice calls need an OpenAI key or ElevenLabs keys on the server. Switch to Text to practise now.</p>}
              {mode === "voice" && voiceReady && engines.length > 1 && (
                <div className="mt-3">
                  <p className="label">Voice engine</p>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1" role="radiogroup" aria-label="Voice engine" onKeyDown={radioKeys(engines, engine ?? engines[0], onEngineChange)}>
                    {engines.map((e) => (
                      <button key={e} type="button" role="radio" aria-checked={engine === e} tabIndex={engine === e ? 0 : -1} onClick={() => onEngineChange(e)}
                        className={`min-h-[34px] rounded-md px-2 text-xs font-semibold transition ${engine === e ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
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

            {error && <p role="alert" className="rounded-lg border border-alert/40 bg-alert-soft p-3 text-sm">{error}</p>}

            <button className="btn-primary btn-xl w-full" onClick={onStart} disabled={blocked}>
              <PhoneCall size={18} aria-hidden /> Start call
            </button>
            <p className="text-center text-xs text-ink-muted">The coach only talks to you. {p.name} never hears it.</p>
          </div>
          <Link href="/library" className="btn-ghost w-full">Change persona</Link>
        </aside>
      </div>
    </div>
  );
}

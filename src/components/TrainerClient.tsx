"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Mic, MicOff, PhoneOff, Send, Keyboard, Settings2, BookOpen, X, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Scenario, buildAgentPrompt } from "@/lib/scenarios";
import { listScenarios } from "@/lib/scenarioStore";
import { saveSession, StoredTurn } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import { formatDuration } from "@/lib/format";
import CallOrb, { type AgentState } from "@/components/CallOrb";
import { PageSkeleton } from "@/components/ui/Skeleton";

type Mode = "voice" | "text";
type Phase = "idle" | "live" | "grading";

interface TextInput { value: string; onChange: (v: string) => void; onSend: () => void; hungUp?: boolean }

interface StageProps {
  scenario: Scenario;
  turns: StoredTurn[];
  elapsed: number;
  orbState: AgentState;
  status: string;
  grading: boolean;
  onEnd: () => void;
  muted?: boolean;
  onToggleMute?: () => void;
  getInputVolume?: () => number;
  getOutputVolume?: () => number;
  manual?: { input: number; output: number };
  text?: TextInput;
  typing?: boolean;
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

function TalkTrack({ scenario, className = "" }: { scenario: Scenario; className?: string }) {
  return (
    <div className={className}>
      <p className="eyebrow">Your goal</p>
      <p className="mt-1 text-sm text-ink">{scenario.traineeGoal}</p>
      <p className="eyebrow mt-4">Talk track</p>
      <pre className="mt-1 whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-soft">{scenario.callScript || "No script."}</pre>
    </div>
  );
}

/** Live-call screen: orb, status, chat transcript, talk-track drawer and the bottom control bar. */
function CallStage({ scenario, turns, elapsed, orbState, status, grading, onEnd, muted, onToggleMute, getInputVolume, getOutputVolume, manual, text, typing }: StageProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const [showTrack, setShowTrack] = useState(false);
  const stickRef = useRef(true);
  const persona = scenario.aiPersona;

  useEffect(() => {
    setShowTrack(window.matchMedia("(min-width: 1024px)").matches);
  }, []);
  // Follow new messages and the typing indicator, unless the user scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns, typing]);
  const lastRole = turns[turns.length - 1]?.role;
  useEffect(() => {
    // Sending your own message always jumps back to the bottom.
    if (lastRole === "user") {
      stickRef.current = true;
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [lastRole, turns.length]);

  return (
    <div className="enter flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[1fr_auto] lg:gap-6">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border border-line bg-white shadow-card lg:min-h-[600px]" aria-label="Call">
        <div className="relative flex shrink-0 flex-col items-center bg-gradient-to-b from-primary-soft/60 to-white px-4 pb-2 pt-3 text-center sm:pb-4 sm:pt-6">
          <CallOrb state={orbState} getInputVolume={getInputVolume} getOutputVolume={getOutputVolume} manual={manual} className="h-16 w-16 sm:h-40 sm:w-40" />
          <h2 className="mt-1 max-w-full truncate text-base font-bold sm:mt-2 sm:text-xl">{persona.name}</h2>
          <p className="hidden text-sm text-ink-muted sm:block">{persona.role}</p>
          <p className="mt-1.5 inline-flex h-8 items-center gap-2 rounded-full bg-white px-3 py-1 text-sm font-medium text-ink shadow-sm ring-1 ring-line" role="status">
            {grading ? <Loader2 size={14} className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden /> : <span className={`h-2 w-2 rounded-full ${orbState === "talking" ? "bg-accent motion-safe:animate-pulse" : orbState === "thinking" ? "bg-amber-500" : "bg-primary"}`} aria-hidden />}
            {status}
          </p>
        </div>

        <div ref={logRef} onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 lg:max-h-[360px]" aria-live="polite" aria-label="Live transcript">
          {turns.length === 0 && !typing && <p className="py-6 text-center text-sm text-ink-muted">The transcript appears here as you talk.</p>}
          {turns.map((t, i) => {
            const me = t.role === "user";
            return (
              <div key={i} className={`flex gap-2.5 ${me ? "justify-end" : "justify-start"}`}>
                {!me && <span className="mt-5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-ink" aria-hidden>{initial(persona.name)}</span>}
                <div className={`max-w-[85%] sm:max-w-[75%] ${me ? "items-end" : "items-start"} flex flex-col`}>
                  <span className="mb-1 px-1 text-xs font-medium text-ink-muted">
                    {me ? "You" : persona.name}
                    {t.timestamp && <span className="ml-1.5 font-normal">{new Date(t.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
                  </span>
                  <p className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${me ? "rounded-br-md bg-primary text-white" : "rounded-bl-md bg-slate-100 text-ink"}`}>{t.text}</p>
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="flex gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-ink" aria-hidden>{initial(persona.name)}</span>
              <p className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3" aria-label={`${persona.name} is typing`}>
                {[0, 150, 300].map((d) => <span key={d} className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
              </p>
            </div>
          )}
        </div>

        {/* Control bar: pinned to the bottom of the call card (the transcript takes the remaining height). */}
        <div className="shrink-0 border-t border-line bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:px-6">
          {text?.hungUp && (
            <div className={`mx-auto mb-3 flex max-w-2xl flex-col items-center gap-2 rounded-2xl bg-amber-50 p-3 text-center text-sm text-amber-900 sm:flex-row sm:justify-between sm:text-left`} role="status">
              <span><strong>{persona.name} hung up.</strong> The call is over.</span>
              <button className="btn-primary btn-pill !h-11" onClick={onEnd} disabled={grading}>Grade this call</button>
            </div>
          )}
          {text && !text.hungUp && (
            <form className="mx-auto mb-3 flex max-w-2xl gap-2" onSubmit={(e) => { e.preventDefault(); text.onSend(); }}>
              <input className="input !h-11 !rounded-full !px-4 disabled:cursor-not-allowed disabled:bg-slate-100" value={grading ? "" : text.value} onChange={(e) => text.onChange(e.target.value)} placeholder={grading ? "Grading…" : "Type what you would say…"} aria-label="Your reply" autoFocus disabled={grading} />
              <button className="btn-primary btn-pill !h-11 !min-w-11 !px-4" disabled={grading || !text.value.trim()} aria-label="Send"><Send size={16} /></button>
            </form>
          )}
          <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="min-w-0 truncate text-sm text-ink-soft">
              <span className="hidden sm:inline">{scenario.title} <span className="mx-1 text-line">|</span></span>
              <span className="font-mono font-semibold tabular-nums text-ink" aria-label={`Elapsed ${formatDuration(elapsed)}`}>{formatDuration(elapsed)}</span>
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              {onToggleMute && (
                <button className={`btn-ghost btn-pill !h-11 !w-11 !min-h-11 !p-0 ${muted ? "!border-red-200 !bg-red-50 !text-red-700" : ""}`} onClick={onToggleMute} aria-pressed={muted} aria-label={muted ? "Unmute microphone" : "Mute microphone"} disabled={grading}>
                  {muted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
              )}
              <button className="btn-danger btn-pill !h-11 !px-5" onClick={onEnd} disabled={grading} aria-label={text?.hungUp ? "Grade call" : "End and grade call"}><PhoneOff size={16} /> {text?.hungUp ? "Grade call" : "End & grade"}</button>
              <button className={`btn-ghost btn-pill !h-11 !w-11 !min-h-11 !p-0 ${showTrack ? "!border-primary !text-primary" : ""}`} onClick={() => setShowTrack((v) => !v)} aria-pressed={showTrack} aria-label="Toggle talk track"><BookOpen size={18} /></button>
            </div>
          </div>
        </div>
      </section>

      {showTrack && (
        <aside className="enter fixed inset-x-3 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-20 max-h-[50vh] overflow-y-auto rounded-2xl border border-line bg-white p-5 shadow-pop lg:static lg:inset-auto lg:max-h-none lg:w-80 lg:shadow-card" aria-label="Talk track">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading text-base font-bold">Talk track</h2>
            <button className="rounded-lg p-1.5 text-ink-muted hover:bg-slate-100" onClick={() => setShowTrack(false)} aria-label="Close talk track"><X size={16} /></button>
          </div>
          <TalkTrack scenario={scenario} />
        </aside>
      )}
    </div>
  );
}

/** Rendered inside ConversationProvider; owns the ElevenLabs session and feeds the shared stage. */
function VoiceSession({
  scenario, active, grading, turns, elapsed, onTurn, onEnded, onError, registerEnd,
}: {
  scenario: Scenario;
  active: boolean;
  grading: boolean;
  turns: StoredTurn[];
  elapsed: number;
  onTurn: (t: StoredTurn) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  registerEnd: (fn: () => void) => void;
}) {
  const conv = useConversation({
    onMessage: ({ message, role }) => onTurn({ role: role === "user" ? "user" : "assistant", text: message }),
    onError: (m: unknown) => onError(typeof m === "string" ? m : "Voice connection error"),
    onDisconnect: () => onEnded(),
  });
  const { startSession, endSession, status, isSpeaking, isMuted, setMuted, getInputVolume, getOutputVolume } = conv;
  const startedRef = useRef(false);

  useEffect(() => registerEnd(() => endSession()), [endSession, registerEnd]);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/elevenlabs/token");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "Could not get a voice token.");  // 429 carries a friendly message
        startSession({
          conversationToken: data.token,
          connectionType: "webrtc",
          overrides: {
            agent: { prompt: { prompt: buildAgentPrompt(scenario) }, firstMessage: scenario.aiPersona.openingLine },
            ...(scenario.aiPersona.voiceId ? { tts: { voiceId: scenario.aiPersona.voiceId } } : {}),
          },
        });
      } catch (e) {
        startedRef.current = false;
        onError(e instanceof Error ? e.message : "Failed to start the call.");
      }
    })();
  }, [active, scenario, startSession, onError]);

  useEffect(() => {
    if (!active) startedRef.current = false;
  }, [active]);

  const connected = status === "connected";
  const orbState: AgentState = grading || !connected ? "thinking" : isSpeaking ? "talking" : "listening";
  const label = grading ? "Grading your call…" : !connected ? "Connecting… allow microphone access" : isMuted ? "Muted" : isSpeaking ? `${scenario.aiPersona.name} is speaking` : "Listening…";
  return (
    <CallStage
      scenario={scenario} turns={turns} elapsed={elapsed} orbState={orbState} status={label} grading={grading}
      onEnd={() => endSession()} muted={isMuted} onToggleMute={() => setMuted(!isMuted)}
      getInputVolume={getInputVolume} getOutputVolume={getOutputVolume}
    />
  );
}

export default function TrainerClient() {
  const { capabilities, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [mode, setMode] = useState<Mode>("voice");
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<StoredTurn[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hungUp, setHungUp] = useState(false);
  const pendingRef = useRef(false); // a reply request is in flight or queued messages are waiting
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const endVoice = useRef<() => void>(() => {});
  const finishing = useRef(false);
  const turnsRef = useRef<StoredTurn[]>([]);
  const [replyTalking, setReplyTalking] = useState(false);
  const talkTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(talkTimer.current), []);

  useEffect(() => {
    const all = listScenarios();
    setScenarios(all);
    const wanted = new URLSearchParams(window.location.search).get("scenario");
    // Functional update: never overwrite a scenario the user already picked.
    setScenarioId((prev) => prev || (all.find((s) => s.id === wanted)?.id ?? all[0].id));
  }, []);

  useEffect(() => {
    if (!isLoading && capabilities && !isAuthenticated) router.replace("/login");
  }, [isLoading, capabilities, isAuthenticated, router]);

  const voiceReady = capabilities?.elevenlabs ?? false;
  useEffect(() => {
    if (capabilities && !capabilities.elevenlabs) setMode("text");
  }, [capabilities]);

  const scenario = useMemo(() => scenarios.find((s) => s.id === scenarioId), [scenarios, scenarioId]);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const addTurn = useCallback((t: StoredTurn) => {
    const stamped = { ...t, timestamp: new Date().toISOString() };
    turnsRef.current = [...turnsRef.current, stamped];
    setTurns(turnsRef.current);
  }, []);

  const finish = useCallback(async () => {
    if (finishing.current || !scenario) return;
    finishing.current = true;
    const transcript = turnsRef.current.filter((t) => t.text.trim());
    const duration = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
    if (!transcript.some((t) => t.role === "user")) {
      setPhase("idle");
      setError("The call ended before you said anything, so there is nothing to grade.");
      finishing.current = false;
      return;
    }
    setPhase("grading");
    let evaluation: Evaluation | null = null;
    try {
      const res = await fetch("/api/evaluate-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, transcript }),
      });
      if (res.ok) evaluation = await res.json();
      else if (res.status === 429) setError((await res.json().catch(() => ({}))).message || "Grading limit reached. The transcript was saved without a score; try again later.");
      else setError("Grading failed; the transcript was saved without a score.");
    } catch {
      setError("Grading failed; the transcript was saved without a score.");
    }
    const useServer = !!capabilities?.database && !capabilities?.demoMode;
    const id = await saveSession({ mode, durationSeconds: duration, scenario, transcript, evaluation }, useServer);
    router.push(`/trainer/debrief/${id}`);
  }, [scenario, mode, capabilities, router]);

  const onVoiceEnded = useCallback(() => void finish(), [finish]);

  function begin() {
    if (!scenario) return;
    setError("");
    turnsRef.current = [];
    setTurns([]);
    finishing.current = false;
    setReplyTalking(false);
    setHungUp(false);
    setBusy(false);
    pendingRef.current = false;
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("live");
    if (mode === "text") addTurn({ role: "assistant", text: scenario.aiPersona.openingLine });
  }

  function hangUp() {
    if (mode === "voice") endVoice.current();
    else void finish();
  }

  /** Drains queued trainee messages: each round answers everything said so far in one turn; nothing is dropped. */
  async function drainReplies() {
    if (pendingRef.current || !scenario) return;
    pendingRef.current = true;
    setBusy(true);
    try {
      // Keep going while the newest turn is the trainee's (they sent more while we waited).
      while (!finishing.current && turnsRef.current[turnsRef.current.length - 1]?.role === "user") {
        const sent = turnsRef.current;
        const res = await fetch("/api/simulate/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario, history: sent.map(({ role, text }) => ({ role, text })) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || "Simulation failed");
        if (finishing.current) break;
        // Slot the reply in right after the messages it answered; later queued messages stay unanswered for the next round.
        const reply: StoredTurn = { role: "assistant", text: data.reply, timestamp: new Date().toISOString() };
        turnsRef.current = [...turnsRef.current.slice(0, sent.length), reply, ...turnsRef.current.slice(sent.length)];
        setTurns(turnsRef.current);
        // No audio in text mode: let the orb "talk" for roughly as long as the reply would take to say.
        setReplyTalking(true);
        clearTimeout(talkTimer.current);
        talkTimer.current = setTimeout(() => setReplyTalking(false), Math.min(4000, 900 + data.reply.length * 25));
        if (data.ended) { setHungUp(true); break; }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function sendText() {
    const text = input.trim();
    if (!text || !scenario || hungUp || finishing.current) return;
    setInput("");
    addTurn({ role: "user", text });
    void drainReplies();
  }

  if (!scenario || !capabilities) return <PageSkeleton rows={2} />;
  const live = phase === "live";
  const grading = phase === "grading";
  const inCall = live || grading;
  const total = scenario.rubric.reduce((a, c) => a + c.weight, 0);
  const persona = scenario.aiPersona;

  const textOrb: AgentState = grading || busy ? "thinking" : replyTalking ? "talking" : "listening";
  const textStatus = grading ? "Grading your call…" : hungUp ? `${persona.name} hung up` : busy ? `${persona.name} is typing…` : replyTalking ? `${persona.name} is replying` : "Your turn";

  const onVoiceError = (m: string) => { setError(m); if (turnsRef.current.length === 0) setPhase("idle"); };

  return (
    <div className={`page ${inCall ? "flex h-[calc(100dvh-var(--header-h,4rem))] min-h-0 flex-col gap-3 !py-3 sm:!py-4 lg:block lg:h-auto lg:space-y-4 lg:!pb-10" : "grid gap-6 lg:grid-cols-[1fr_400px]"}`}>
      <h1 className={`font-bold lg:col-span-2 ${inCall ? "shrink-0 truncate text-lg sm:text-2xl" : "text-xl sm:text-3xl"}`}>Practice: {scenario.title}</h1>
      {error && <p role="alert" className="shrink-0 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 lg:col-span-2">{error}</p>}

      {inCall ? (
        mode === "voice" ? (
          <ConversationProvider>
            <VoiceSession scenario={scenario} active={live} grading={grading} turns={turns} elapsed={elapsed} onTurn={addTurn} onEnded={onVoiceEnded} onError={onVoiceError} registerEnd={(fn) => { endVoice.current = fn; }} />
          </ConversationProvider>
        ) : (
          <CallStage
            scenario={scenario} turns={turns} elapsed={elapsed} orbState={textOrb} status={textStatus} grading={grading} onEnd={hangUp}
            manual={{ input: textOrb === "listening" ? 0.25 : 0, output: textOrb === "talking" ? 0.6 : 0 }}
            text={{ value: input, onChange: setInput, onSend: sendText, hungUp }} typing={busy && !hungUp}
          />
        )
      ) : (
        <>
          {/* Pre-call: on phones the orb and Start button come first, scenario details below. */}
          <section className="enter order-1 flex flex-col items-center rounded-3xl border border-line bg-gradient-to-b from-primary-soft/60 via-white to-white p-5 text-center shadow-card sm:p-8 lg:order-2 lg:justify-center">
            <CallOrb state={null} className="h-32 w-32 sm:h-48 sm:w-48" />
            <p className="eyebrow mt-3">Ready when you are</p>
            <h2 className="mt-1 text-xl font-bold sm:text-2xl">{persona.name}</h2>
            <p className="text-sm text-ink-muted">{persona.role}</p>

            <div className="mt-4 grid w-full max-w-xs grid-cols-2 gap-1 rounded-full bg-slate-100 p-1 text-sm font-semibold" role="tablist" aria-label="Practice mode">
              {(["voice", "text"] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                  className={`flex min-h-[40px] items-center justify-center gap-2 rounded-full px-3 transition ${mode === m ? "bg-white text-primary shadow-sm" : "text-ink-muted hover:text-ink"}`}>
                  {m === "voice" ? <Mic size={15} /> : <Keyboard size={15} />}{m === "voice" ? "Voice" : "Text"}
                </button>
              ))}
            </div>

            {mode === "voice" && !voiceReady && (
              <div className="banner-warn mt-4 w-full text-left" role="status">
                <p><strong>Voice calls aren’t set up yet.</strong> You can still practise by typing.</p>
                <button className="btn-primary mt-2 w-full" onClick={() => setMode("text")}><Keyboard size={16} /> Use text simulation</button>
              </div>
            )}
            {mode === "text" && !capabilities.llm && (
              <div className="banner-warn mt-4 w-full text-left" role="status">
                AI isn’t connected, so the caller answers with simple scripted replies and grading is an automatic estimate.
              </div>
            )}

            <button className="btn-accent btn-pill btn-xl mt-5 w-full max-w-xs shadow-orb" onClick={begin} disabled={mode === "voice" && !voiceReady} aria-describedby={mode === "voice" && !voiceReady ? undefined : "start-hint"}>
              {mode === "voice" ? <Mic size={20} /> : <Keyboard size={20} />} Start {mode === "voice" ? "call" : "simulation"}
            </button>
            {!(mode === "voice" && !voiceReady) && (
              <p className="mt-3 max-w-xs text-xs text-ink-soft" id="start-hint">
                {mode === "voice" ? "Your browser will ask for microphone access when the call starts." : "Type your side of the call; the caller replies instantly."}
              </p>
            )}
          </section>

          <aside className="order-2 space-y-4 lg:order-1">
            <div className="card">
              <label htmlFor="scenario" className="label">Scenario</label>
              <select id="scenario" className="input" value={scenarioId} onChange={(e) => {
                setScenarioId(e.target.value);
                // Keep the choice in the URL so a remount/reload restores it.
                window.history.replaceState(null, "", `/trainer?scenario=${encodeURIComponent(e.target.value)}`);
              }}>
                {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}{s.builtIn ? "" : " (custom)"}</option>)}
              </select>
              <div className="mt-4 space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <span className="badge bg-primary-soft text-primary">{scenario.industry || "General"}</span>
                  <span className="badge bg-accent-soft text-ink">{scenario.difficulty}</span>
                </div>
                <p><span className="eyebrow block">You’re talking to</span>{persona.name}, {persona.role}</p>
                <p><span className="eyebrow block">Your goal</span>{scenario.traineeGoal}</p>
                <details className="group rounded-xl bg-slate-50 p-3">
                  <summary className="cursor-pointer font-semibold">Talk track</summary>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink-soft">{scenario.callScript || "No script."}</pre>
                </details>
                <details className="rounded-xl bg-slate-50 p-3">
                  <summary className="cursor-pointer font-semibold">Rubric ({scenario.rubric.length})</summary>
                  <ul className="mt-2 space-y-1 text-xs text-ink-soft">
                    {scenario.rubric.map((c) => <li key={c.id} className="flex justify-between gap-2"><span>{c.name}</span><span className="shrink-0 whitespace-nowrap font-semibold">{Math.round(c.weight)}%</span></li>)}
                  </ul>
                  <p className={`mt-2 text-xs ${Math.round(total) === 100 ? "text-ink-muted" : "font-semibold text-amber-800"}`}>
                    Weights total {Math.round(total)}%{Math.round(total) === 100 ? "" : " (not 100, so scores are rescaled)"}
                  </p>
                </details>
              </div>
              <Link href="/trainer/scenarios" className="btn-ghost mt-4 w-full"><Settings2 size={16} /> Edit scenarios</Link>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

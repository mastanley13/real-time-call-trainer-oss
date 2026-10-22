"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Mic, MicOff, PhoneOff, Phone, Send, Keyboard, Settings2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Scenario, buildAgentPrompt } from "@/lib/scenarios";
import { listScenarios } from "@/lib/scenarioStore";
import { saveSession, StoredTurn } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";

type Mode = "voice" | "text";
type Phase = "idle" | "live" | "grading";

/** Rendered inside ConversationProvider; owns the ElevenLabs session. */
function VoiceSession({
  scenario, active, onTurn, onEnded, onError, registerEnd,
}: {
  scenario: Scenario;
  active: boolean;
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
  const { startSession, endSession, status, isSpeaking, isMuted, setMuted } = conv;
  const startedRef = useRef(false);

  useEffect(() => registerEnd(() => endSession()), [endSession, registerEnd]);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/elevenlabs/token");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "Could not get a voice token.");
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

  if (!active) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm">
      <span className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${status === "connected" ? (isSpeaking ? "animate-pulse bg-accent" : "bg-primary") : "bg-amber-400"}`} />
        {status === "connected" ? (isSpeaking ? `${scenario.aiPersona.name} is speaking` : "Listening…") : "Connecting… allow microphone access"}
      </span>
      <button className="btn-ghost !min-h-[36px]" onClick={() => setMuted(!isMuted)} aria-pressed={isMuted}>
        {isMuted ? <MicOff size={16} /> : <Mic size={16} />} {isMuted ? "Unmute" : "Mute"}
      </button>
    </div>
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
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const endVoice = useRef<() => void>(() => {});
  const finishing = useRef(false);
  const turnsRef = useRef<StoredTurn[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const all = listScenarios();
    setScenarios(all);
    const wanted = new URLSearchParams(window.location.search).get("scenario");
    setScenarioId(all.find((s) => s.id === wanted)?.id ?? all[0].id);
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

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

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
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("live");
    if (mode === "text") addTurn({ role: "assistant", text: scenario.aiPersona.openingLine });
  }

  function hangUp() {
    if (mode === "voice") endVoice.current();
    else void finish();
  }

  async function sendText() {
    const text = input.trim();
    if (!text || busy || !scenario) return;
    setInput("");
    addTurn({ role: "user", text });
    setBusy(true);
    try {
      const res = await fetch("/api/simulate/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, history: turnsRef.current.map(({ role, text }) => ({ role, text })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Simulation failed");
      addTurn({ role: "assistant", text: data.reply });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  if (!scenario || !capabilities) return <div className="page text-ink-muted">Loading…</div>;
  const live = phase === "live";
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="page grid gap-6 lg:grid-cols-[360px_1fr]">
      <aside className="space-y-4">
        <div className="card">
          <label htmlFor="scenario" className="label">Scenario</label>
          <select id="scenario" className="input" value={scenarioId} disabled={phase !== "idle"} onChange={(e) => setScenarioId(e.target.value)}>
            {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}{s.builtIn ? "" : " (custom)"}</option>)}
          </select>
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <span className="badge bg-primary-soft text-primary">{scenario.industry || "General"}</span>
              <span className="badge bg-accent-soft text-ink">{scenario.difficulty}</span>
            </div>
            <p><span className="font-semibold">You’re talking to:</span> {scenario.aiPersona.name}, {scenario.aiPersona.role}</p>
            <p><span className="font-semibold">Your goal:</span> {scenario.traineeGoal}</p>
            <details className="rounded-xl bg-slate-50 p-3">
              <summary className="cursor-pointer font-semibold">Talk track</summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-ink-soft">{scenario.callScript || "No script."}</pre>
            </details>
            <details className="rounded-xl bg-slate-50 p-3">
              <summary className="cursor-pointer font-semibold">Rubric ({scenario.rubric.length})</summary>
              <ul className="mt-2 space-y-1 text-xs text-ink-soft">
                {scenario.rubric.map((c) => <li key={c.id}>• {c.name} ({Math.round(c.weight)}%)</li>)}
              </ul>
            </details>
          </div>
          <Link href="/trainer/scenarios" className="btn-ghost mt-4 w-full"><Settings2 size={16} /> Edit scenarios</Link>
        </div>
      </aside>

      <section className="card flex min-h-[520px] flex-col">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-sm font-semibold" role="tablist">
            {(["voice", "text"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} disabled={phase !== "idle"} onClick={() => setMode(m)}
                className={`flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3 ${mode === m ? "bg-white text-primary shadow-sm" : "text-ink-muted"}`}>
                {m === "voice" ? <Mic size={15} /> : <Keyboard size={15} />}{m === "voice" ? "Voice call" : "Text simulation"}
              </button>
            ))}
          </div>
          {live && <span className="font-mono text-sm text-ink-muted" aria-live="off">{mmss}</span>}
        </div>

        {mode === "voice" && !voiceReady && (
          <div className="banner-warn mb-4" role="status">
            <strong>ElevenLabs not configured.</strong> Set <code>ELEVENLABS_API_KEY</code> and <code>ELEVENLABS_AGENT_ID</code> to enable voice calls, or switch to the text simulation.
          </div>
        )}
        {mode === "text" && !capabilities.llm && (
          <div className="banner-warn mb-4" role="status">
            No LLM key set: the caller will reply with the scenario’s scripted lines and grading will use the keyword heuristic.
          </div>
        )}
        {error && <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

        {voiceReady && mode === "voice" && (
          <ConversationProvider>
            <VoiceSession scenario={scenario} active={live} onTurn={addTurn} onEnded={onVoiceEnded} onError={(m) => { setError(m); if (turnsRef.current.length === 0) setPhase("idle"); }} registerEnd={(fn) => { endVoice.current = fn; }} />
          </ConversationProvider>
        )}

        <div ref={logRef} className="my-3 flex-1 space-y-3 overflow-y-auto" aria-live="polite" style={{ maxHeight: 420 }}>
          {turns.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-muted">
              {phase === "idle" ? "Pick a scenario and start the call. The transcript appears here." : "Waiting for the caller…"}
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${t.role === "user" ? "bg-primary text-white" : "bg-slate-100 text-ink"}`}>
                <p className="mb-0.5 text-[11px] font-semibold uppercase opacity-70">{t.role === "user" ? "You" : scenario.aiPersona.name}</p>
                {t.text}
              </div>
            </div>
          ))}
        </div>

        {phase === "grading" ? (
          <p className="rounded-xl bg-primary-soft p-3 text-center text-sm font-medium text-primary" role="status">Grading your call…</p>
        ) : live ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {mode === "text" && (
              <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); void sendText(); }}>
                <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type what you would say…" aria-label="Your reply" disabled={busy} autoFocus />
                <button className="btn-primary" disabled={busy || !input.trim()} aria-label="Send"><Send size={16} /></button>
              </form>
            )}
            <button className="btn-danger" onClick={hangUp}><PhoneOff size={16} /> End &amp; grade</button>
          </div>
        ) : (
          <button className="btn-accent w-full sm:w-auto sm:self-start" onClick={begin} disabled={mode === "voice" && !voiceReady}>
            <Phone size={16} /> Start {mode === "voice" ? "call" : "simulation"}
          </button>
        )}
      </section>
    </div>
  );
}

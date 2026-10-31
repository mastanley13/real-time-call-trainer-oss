"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useAuth } from "@/contexts/AuthContext";
import { Scenario, ScenarioSchema, buildAgentPrompt } from "@/lib/scenarios";
import { listScenarios } from "@/lib/scenarioStore";
import { getLocalSession, saveSession, type CoachLog, type StoredTurn } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import type { CoachMode } from "@/lib/coach-types";
import type { AgentState } from "@/components/CallOrb";
import { PageSkeleton } from "@/components/ui/Skeleton";
import Briefing from "@/components/call/Briefing";
import Deck from "@/components/call/Deck";
import RealtimeVoiceSession, { type VoiceRender } from "@/components/call/RealtimeVoiceSession";
import { useCoach, type LiveCue } from "@/components/call/useCoach";
import { chooseVoiceEngine, type VoiceEngine } from "@/lib/realtime";

type Mode = "voice" | "text";
type Phase = "idle" | "live" | "grading";
const LAST_SCENARIO = "rtct.lastScenario";
const COACH_MODE = "rtct.coachMode";
const VOICE_ENGINE = "rtct.voiceEngine";

/** The asked-for persona, else the first reviewed built-in, else whatever the library has first. */
const choose = (all: Scenario[], id: string | null) => all.find((s) => s.id === id) ?? all.find((s) => s.builtIn && s.status === "reviewed") ?? all[0];
/** Said when a link names a persona this browser doesn't have, so the rep knows the buyer changed. */
const missingNotice = (asked: string | null, picked: Scenario) =>
  asked && picked.id !== asked ? `That persona isn't in this browser's library, so we opened ${picked.aiPersona.name} instead. Pick another in the Library.` : "";

/** Rendered inside ConversationProvider; owns the ElevenLabs session and feeds the shared deck. */
function VoiceSession({ scenario, active, grading, onTurn, onEnded, onError, registerEnd, render }: {
  scenario: Scenario;
  active: boolean;
  grading: boolean;
  onTurn: (t: StoredTurn) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
  registerEnd: (fn: () => void) => void;
  render: (v: { orbState: AgentState; status: { label: string; tone: "ok" | "signal" | "caution" }; muted: boolean; toggleMute: () => void; end: () => void; getInputVolume: () => number; getOutputVolume: () => number }) => React.ReactNode;
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

  const connected = status === "connected";
  const orbState: AgentState = grading || !connected ? "thinking" : isSpeaking ? "talking" : "listening";
  const name = scenario.aiPersona.name.split(" ")[0];
  const statusLabel = !connected
    ? { label: "Connecting… allow the mic", tone: "caution" as const }
    : isMuted ? { label: "Muted", tone: "caution" as const }
    : isSpeaking ? { label: `${name} is speaking`, tone: "signal" as const }
    : { label: "Your turn", tone: "ok" as const };
  return <>{render({ orbState, status: statusLabel, muted: isMuted, toggleMute: () => setMuted(!isMuted), end: () => endSession(), getInputVolume, getOutputVolume })}</>;
}

export default function TrainerClient() {
  const { capabilities, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [mode, setMode] = useState<Mode>("voice");
  const [engine, setEngineState] = useState<VoiceEngine | null>(null);
  const [coachMode, setCoachModeState] = useState<CoachMode>("coached");
  const [phase, setPhase] = useState<Phase>("idle");
  const [turns, setTurns] = useState<StoredTurn[]>([]);
  const [input, setInput] = useState("");
  const [inserted, setInserted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** Who wrote the latest text-call reply: the configured model, or the scripted fallback. */
  const [callerSource, setCallerSource] = useState<"llm" | "scripted" | null>(null);
  const [busy, setBusy] = useState(false);
  const [hungUp, setHungUp] = useState(false);
  const [retry, setRetry] = useState<{ seed: StoredTurn[]; turn: number; line: string } | null>(null);
  const pendingRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const endVoice = useRef<() => void>(() => {});
  const finishing = useRef(false);
  const turnsRef = useRef<StoredTurn[]>([]);
  const [replyTalking, setReplyTalking] = useState(false);
  const talkTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const live = phase === "live";
  const grading = phase === "grading";
  const coach = useCoach(scenario ?? undefined, turns, { mode: coachMode, live });

  useEffect(() => () => clearTimeout(talkTimer.current), []);

  // Pick the scenario: ?retry=<session>&turn=<n>, else ?scenario=<id>, else the last one practised, else the first reviewed one.
  // Re-runs when the query changes, so the command palette can switch persona without a full page load.
  const query = useSearchParams()?.toString() ?? "";
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  useEffect(() => {
    if (phaseRef.current !== "idle") return;
    const params = new URLSearchParams(query);
    let alive = true;
    setError("");
    try {
      const saved = localStorage.getItem(COACH_MODE);
      if (saved === "blind" || saved === "guided" || saved === "coached") setCoachModeState(saved);
    } catch { /* storage unavailable */ }
    const asked = params.get("scenario");
    // Without ?scenario=, use the persona practised last.
    const wanted = () => {
      if (asked) return asked;
      try { return localStorage.getItem(LAST_SCENARIO); } catch { return null; }
    };
    const retryId = params.get("retry");
    const retryTurn = Number(params.get("turn"));
    if (retryId && retryTurn > 0) {
      const load = async () => {
        if (retryId.startsWith("local-")) {
          const s = getLocalSession(retryId);
          return s ? { scenario: s.scenario, transcript: s.transcript } : null;
        }
        const r = await fetch(`/api/transcripts/${retryId}`);
        if (!r.ok) return null;
        const { session } = await r.json();
        const sc = listScenarios().find((x) => x.id === session.scenarioId);
        return sc ? { scenario: sc, transcript: session.transcript as StoredTurn[] } : null;
      };
      // If the session cannot be loaded, start that persona from the beginning (?scenario=<id>, else the usual pick) and say so.
      const fallback = () => {
        const picked = choose(listScenarios(), wanted());
        setRetry(null);
        setScenario(picked);
        setNotice(missingNotice(asked, picked));
        setError("That call could not be loaded, so the retry starts from the beginning.");
      };
      load().then((found) => {
        if (!alive) return;
        if (!found) { fallback(); return; }
        const parsed = ScenarioSchema.safeParse(found.scenario);
        const sc = parsed.success ? parsed.data : found.scenario;
        const seed = found.transcript.slice(0, retryTurn).map(({ role, text }) => ({ role, text }));
        setScenario(sc);
        setNotice("");
        setMode("text");
        setRetry({ seed, turn: retryTurn, line: seed[seed.length - 1]?.text ?? "" });
      }).catch(() => { if (alive) fallback(); });
      return () => { alive = false; };
    }
    const picked = choose(listScenarios(), wanted());
    setRetry(null);
    setScenario(picked);
    setNotice(missingNotice(asked, picked));
  }, [query]);

  useEffect(() => {
    if (!isLoading && capabilities && !isAuthenticated) router.replace("/login");
  }, [isLoading, capabilities, isAuthenticated, router]);

  // Voice engine: the viewer's last pick if the server still offers it, else the server's first (OpenAI when a key is set).
  useEffect(() => {
    if (!capabilities) return;
    const engines = capabilities.voiceEngines ?? (capabilities.elevenlabs ? ["elevenlabs" as const] : []);
    let saved: string | null = null;
    try { saved = localStorage.getItem(VOICE_ENGINE); } catch { /* storage unavailable */ }
    const pick = chooseVoiceEngine(engines, saved);
    setEngineState(pick);
    if (!pick) setMode("text");
  }, [capabilities]);

  // While a call is live, the page becomes the deck: site chrome hides (see globals.css).
  useEffect(() => {
    const el = document.documentElement;
    if (phase !== "idle") el.setAttribute("data-incall", ""); else el.removeAttribute("data-incall");
    return () => el.removeAttribute("data-incall");
  }, [phase]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [live]);

  const setEngine = (e: VoiceEngine) => {
    setEngineState(e);
    try { localStorage.setItem(VOICE_ENGINE, e); } catch { /* ignore */ }
  };

  const setCoachMode = (m: CoachMode) => {
    setCoachModeState(m);
    try { localStorage.setItem(COACH_MODE, m); } catch { /* ignore */ }
  };

  const addTurn = useCallback((t: StoredTurn) => {
    const stamped = { ...t, timestamp: new Date().toISOString() };
    turnsRef.current = [...turnsRef.current, stamped];
    setTurns(turnsRef.current);
  }, []);

  const coachRef = useRef(coach);
  coachRef.current = coach;

  const finish = useCallback(async () => {
    if (finishing.current || !scenario) return;
    finishing.current = true;
    const transcript = turnsRef.current.filter((t) => t.text.trim());
    const duration = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
    if (!transcript.some((t) => t.role === "user")) {
      setPhase("idle");
      // Keep a connection error that ended the call: it says what went wrong and how to fix it.
      setError((cur) => cur || "The call ended before you said anything, so there is nothing to grade.");
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
      else if (res.status === 429 || res.status === 503) setError((await res.json().catch(() => ({}))).message || "Grading limit reached. The transcript was saved without a score; try again later.");
      else setError("Grading failed; the transcript was saved without a score.");
    } catch {
      setError("Grading failed; the transcript was saved without a score.");
    }
    const c = coachRef.current;
    const coachLog: CoachLog = {
      mode: coachMode,
      source: c.result?.source,
      model: c.result?.model,
      p50Ms: c.p50,
      cues: c.cues.map((q) => ({ triggerTurn: q.triggerTurn, type: q.type, title: q.title, used: q.status === "used" })),
    };
    const useServer = !!capabilities?.database && !capabilities?.demoMode;
    const id = await saveSession({ mode, durationSeconds: duration, scenario, transcript, evaluation, coach: coachLog }, useServer);
    router.push(`/trainer/debrief/${id}`);
  }, [scenario, mode, capabilities, router, coachMode]);

  const onVoiceEnded = useCallback(() => void finish(), [finish]);

  function begin() {
    if (!scenario) return;
    try { localStorage.setItem(LAST_SCENARIO, scenario.id); } catch { /* ignore */ }
    setError("");
    coach.reset();
    const seed = retry?.seed.map((t) => ({ ...t, timestamp: new Date().toISOString() })) ?? [];
    turnsRef.current = seed;
    setTurns(seed);
    finishing.current = false;
    setReplyTalking(false);
    setHungUp(false);
    setCallerSource(null);
    setBusy(false);
    setInput("");
    setInserted(false);
    pendingRef.current = false;
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("live");
    if (mode === "text" && !seed.length) addTurn({ role: "assistant", text: scenario.aiPersona.openingLine });
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
        const reply: StoredTurn = { role: "assistant", text: data.reply, timestamp: new Date().toISOString() };
        // The reply answers what was sent, so it goes right after it, ahead of anything typed since.
        const at = sent.length;
        const inserted = turnsRef.current.length > at;
        turnsRef.current = [...turnsRef.current.slice(0, at), reply, ...turnsRef.current.slice(at)];
        setTurns(turnsRef.current);
        if (inserted) coachRef.current.shift(at);
        if (data.source === "llm" || data.source === "scripted") setCallerSource(data.source);
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
    setInserted(false);
    addTurn({ role: "user", text });
    void drainReplies();
  }

  function insertCue(cue: LiveCue) {
    if (!cue.suggestedLine) return;
    coach.use(cue.id);
    if (mode === "text") { setInput(cue.suggestedLine); setInserted(true); }
  }

  const coachLabel = useMemo(() => {
    if (coachMode === "blind") return "Coach off";
    const src = coach.result?.source;
    const model = coach.result?.model ?? capabilities?.model;
    const latency = coach.p50 != null ? ` · p50 ${coach.p50 < 100 ? "<0.1" : (coach.p50 / 1000).toFixed(1)}s` : "";
    if (src === "heuristic" || (!src && !capabilities?.llm)) return `Coach: rules-based${latency}`;
    return `Coach: ${model ?? "AI"}${latency}`;
  }, [coachMode, coach.result, coach.p50, capabilities]);

  if (!scenario || !capabilities) return <PageSkeleton rows={2} />;

  if (phase === "idle") {
    return (
      // Keyed by persona: revealed prep answers, "Got it" and the mic test belong to one buyer.
      <Briefing key={scenario.id} scenario={scenario} capabilities={capabilities} mode={mode} onModeChange={setMode} engine={engine} onEngineChange={setEngine} coachMode={coachMode} onCoachModeChange={setCoachMode}
        onStart={begin} retryFrom={retry ? { turn: retry.turn, line: retry.line } : null} error={error} notice={notice} />
    );
  }

  const gradingLabel = capabilities.llm ? `Graded by ${capabilities.model ?? "your model"} after the call` : "Rules-based estimate (no AI key)";
  const shared = { scenario, turns, startedAt: startedAt.current, elapsed, grading, gradingLabel, coach, coachMode, onCoachModeChange: setCoachMode, coachLabel, inserted, onInsert: insertCue, error };

  if (mode === "voice" && engine) {
    const voiceProps = {
      scenario, active: live, grading, onTurn: addTurn, onEnded: onVoiceEnded,
      // With nothing from the rep there is nothing to grade: go back to the briefing, where the error explains what happened.
      onError: (m: string) => { setError(m); if (!turnsRef.current.some((t) => t.role === "user" && t.text.trim())) setPhase("idle"); },
      registerEnd: (fn: () => void) => { endVoice.current = fn; },
      render: (v: VoiceRender) => (
        <Deck {...shared} orbState={v.orbState} status={grading ? { label: "Grading…", tone: "signal" } : v.status} onEnd={v.end}
          voice={{ engine, muted: v.muted, onToggleMute: v.toggleMute, getInputVolume: v.getInputVolume, getOutputVolume: v.getOutputVolume }} />
      ),
    };
    // Coach cues stay on the trainee's screen: neither engine is ever sent coach output.
    if (engine === "openai") return <RealtimeVoiceSession {...voiceProps} />;
    return (
      <ConversationProvider>
        <VoiceSession {...voiceProps} />
      </ConversationProvider>
    );
  }

  const name = scenario.aiPersona.name.split(" ")[0];
  const textOrb: AgentState = grading || busy ? "thinking" : replyTalking ? "talking" : "listening";
  const status = grading ? { label: "Grading…", tone: "signal" as const }
    : hungUp ? { label: `${name} hung up`, tone: "caution" as const }
    : busy ? { label: `${name} is typing…`, tone: "signal" as const }
    : { label: "Your turn", tone: "ok" as const };
  // Name what is playing the persona: the configured model, or the scripted fallback (no key, or the model call failed).
  const caller = (callerSource ?? (capabilities.llm ? "llm" : "scripted")) === "llm" ? `Text · ${capabilities.model ?? "AI model"}` : "Text · scripted";
  return (
    <Deck {...shared} orbState={textOrb} status={status} onEnd={hangUp}
      text={{ value: input, onChange: (v) => { setInput(v); if (!v) setInserted(false); }, onSend: sendText, hungUp, typing: busy && !hungUp, caller }} />
  );
}

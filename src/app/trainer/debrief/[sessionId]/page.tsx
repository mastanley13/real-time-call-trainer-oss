"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, CheckCircle2, ChevronDown, Clock, FileQuestion, Loader2, Printer, Quote, RefreshCw, RotateCcw, Share2, TrendingUp, Trophy, WifiOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { COMPETITION_MAX_ATTEMPTS, type CompetitionFinalizeResult } from "@/lib/competition";
import { getLocalSession, readLocalSessionsStrict, updateLocalEvaluation, type CoachLog } from "@/lib/sessionStore";
import { listScenarios } from "@/lib/scenarioStore";
import type { Scenario } from "@/lib/scenarios";
import type { Evaluation } from "@/lib/grader-types";
import { debriefHeadline, goalStatusOf, graderLabel, isLegacyGrader, isLlmFailedGrade, scoreLabel, stripGraderNote } from "@/lib/grader-types";
import { LOCAL_SESSION_CAP, TRANSCRIPT_LIST_CAP, nextDrill, retryPoint, showFirstGradedDemo, viewerOwnsSession } from "@/lib/debrief";
import { canRegrade, isAiGrade, wasCapped } from "@/lib/gradable";
import { canManageTeam } from "@/lib/team";
import { CUE_LABELS } from "@/lib/coach-types";
import { formatDuration } from "@/lib/format";
import { voiceLabel } from "@/lib/billingUi";
import EmptyState from "@/components/ui/EmptyState";
import { DebriefSkeleton } from "@/components/ui/Skeleton";
import { PersonaAvatar } from "@/components/ui/Persona";
import { CUE_ICON } from "@/components/call/CopilotRail";

interface View {
  title: string;
  scenario?: Scenario;
  scenarioId?: string;
  role?: string;
  createdAt: string;
  durationSeconds: number;
  transcript: { role: string; text: string }[];
  evaluation: Evaluation | null;
  supervisorNotes?: string | null;
  callerName: string;
  coach?: CoachLog;
  local: boolean;
  /** The trainee who made a server-stored call. */
  ownerId?: string;
  /** Voice tier the call ran on, for server-stored voice calls. Never a model id. */
  voiceUsed?: "premium" | "standard" | null;
  /** Official championship result when this call was a competition attempt. */
  competition?: CompetitionFinalizeResult | null;
}

/** Older heuristic sessions stored keyword-stem rationales; never show those to users. */
const friendlyRationale = (raw: string) => {
  const r = stripGraderNote(raw);
  return /^Keyword match:/.test(r) ? r.replace(/^Keyword match: the trainee touched on (\d+) of (\d+) themes from this criterion.*$/, "You addressed $1 of $2 expected points for this area.") : r;
};
const friendlySummary = (ev: Evaluation) =>
  /^Heuristic score/.test(ev.summary) ? `Automatic estimate: ${ev.overallScore}/100, based on how many of the rubric's topics you covered.` : ev.summary;

const tone = (n: number) => (n >= 80 ? "ok" : n >= 60 ? "signal" : "caution");
const TEXT = { ok: "text-ok", signal: "text-signal", caution: "text-caution" } as const;
const BG = { ok: "bg-ok", signal: "bg-signal", caution: "bg-caution" } as const;
/** Load failures that a retry cannot fix: the session is gone or lives in another browser. */
const NOT_FOUND = "Session not found.";
const NOT_LOCAL = "This session isn’t stored in this browser.";
/** Categorical tokens --cat-1 to --cat-8 from globals.css. */
const CRIT_COLORS = Array.from({ length: 8 }, (_, i) => `rgb(var(--cat-${i + 1}))`);

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 52, c = 2 * Math.PI * r;
  const t = tone(score);
  return (
    <div className={`relative h-40 w-40 shrink-0 ${TEXT[t]}`} role="img" aria-label={`Grade ${grade}, ${score} out of 100, ${scoreLabel(score)}`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgb(var(--line))" strokeWidth="8" />
        {Array.from({ length: 40 }, (_, i) => {
          const a = (i / 40) * Math.PI * 2;
          return <line key={i} x1={60 + Math.cos(a) * 60} y1={60 + Math.sin(a) * 60} x2={60 + Math.cos(a) * 57} y2={60 + Math.sin(a) * 57} stroke="rgb(var(--line))" strokeWidth="1" />;
        })}
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, score)) / 100)} className="transition-[stroke-dashoffset] duration-700 ease-out" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="mono text-5xl font-semibold leading-none">{score}</span>
        <span className="mt-1 font-heading text-sm font-bold text-ink">Grade {grade}</span>
      </div>
    </div>
  );
}

export default function DebriefPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { isAuthenticated, isLoading, capabilities, user } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  /** Bumped by Try again after a failed load, which reruns the load effect. */
  const [attempt, setAttempt] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const [regrading, setRegrading] = useState(false);
  const [regradeMsg, setRegradeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lineRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const regradeMsgRef = useRef<HTMLParagraphElement>(null);
  // After a successful re-grade the button is usually gone (the grade is now an AI grade), so focus moves to the message that says what happened.
  useEffect(() => { if (regradeMsg?.ok) regradeMsgRef.current?.focus(); }, [regradeMsg]);

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (sessionId.startsWith("local-")) {
      const s = getLocalSession(sessionId);
      if (!s) { setError(NOT_LOCAL); return; }
      setView({ title: s.scenario.title, scenario: s.scenario, scenarioId: s.scenario.id, role: s.scenario.role, createdAt: s.createdAt, durationSeconds: s.durationSeconds, transcript: s.transcript, evaluation: s.evaluation, callerName: s.scenario.aiPersona.name, coach: s.coach, local: true });
      return;
    }
    if (!isAuthenticated) { router.replace("/login"); return; }
    // The voice label comes from its own route so the session view stays an exact allowlist. It is optional:
    // a failed lookup only hides the label.
    const voice: Promise<"premium" | "standard" | null> = fetch(`/api/transcripts/${encodeURIComponent(sessionId)}/voice`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d?.voiceUsed === "premium" || d?.voiceUsed === "standard" ? d.voiceUsed : null))
      .catch(() => null);
    fetch(`/api/transcripts/${sessionId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? NOT_FOUND : "Could not load this session.");
        const { session } = await r.json();
        const sc = listScenarios().find((x) => x.id === session.scenarioId);
        setView({ title: session.scenarioTitle ?? session.scenarioId, scenario: sc, scenarioId: session.scenarioId, role: sc?.role, createdAt: session.createdAt, durationSeconds: session.durationSeconds, transcript: session.transcript, evaluation: session.evaluation, supervisorNotes: session.supervisorNotes, callerName: sc?.aiPersona.name ?? "Caller", local: false, ownerId: session.userId, voiceUsed: await voice, competition: session.competition ?? null });
      })
      .catch((e) => setError(e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : e.message));
  }, [sessionId, capabilities, isLoading, isAuthenticated, router, attempt]);

  const ev = view?.evaluation ?? null;

  // First graded debrief: offer a team demo. Only the other sessions matter, so this runs once per loaded call.
  // A failed list lookup (storage or network) leaves the button hidden, and so does a list cut off at its cap.
  // Only the session's owner sees it: a manager's own list says nothing about a trainee's call, so it is not fetched.
  const viewLocal = view ? view.local : null;
  const ownsView = view ? viewerOwnsSession(view, user?.id) : false;
  const [sessionGrades, setSessionGrades] = useState<{ sessions: { id: string; graded: boolean }[]; cap: number } | null>(null);
  useEffect(() => {
    setSessionGrades(null);
    if (viewLocal === null || !ownsView) return;
    if (viewLocal) {
      const local = readLocalSessionsStrict();
      if (local) setSessionGrades({ sessions: local.map((s) => ({ id: s.id, graded: !!s.evaluation })), cap: LOCAL_SESSION_CAP });
      return;
    }
    let live = true;
    fetch("/api/transcripts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { sessions?: { id: string; overallScore: number | null; graderMethod: string | null }[] } | null) => {
        const list = d?.sessions;
        if (live && Array.isArray(list)) setSessionGrades({ sessions: list.map((s) => ({ id: s.id, graded: s.overallScore != null || s.graderMethod != null })), cap: TRANSCRIPT_LIST_CAP });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [viewLocal, ownsView, sessionId]);
  // A rules-based stand-in for a failed AI grade doesn't count as this call's first grade.
  const firstGraded = ownsView && sessionGrades !== null && showFirstGradedDemo(sessionId, !!ev && !isLlmFailedGrade(ev), sessionGrades.sessions, sessionGrades.cap);

  const critColor = useMemo(() => Object.fromEntries((ev?.criteria ?? []).map((c, i) => [c.id, CRIT_COLORS[i % CRIT_COLORS.length]])), [ev]);
  /** For each transcript line, the criteria whose evidence cites it. */
  const lineCriteria = useMemo(() => {
    const m: Record<number, string[]> = {};
    for (const c of ev?.criteria ?? []) for (const e of c.evidence) if (e.line) (m[e.line] ??= []).push(c.id);
    return m;
  }, [ev]);
  const retry = useMemo(() => (view && ev ? retryPoint(view.transcript, ev) : null), [view, ev]);
  const drill = useMemo(() => {
    if (!view || !ev?.criteria.length) return undefined;
    const weakest = [...ev.criteria].sort((a, b) => a.score - b.score)[0];
    return nextDrill(listScenarios(), { id: view.scenarioId, role: view.role }, weakest.name);
  }, [view, ev]);

  function jump(line: number) {
    setFocus(line);
    const li = lineRefs.current[line];
    li?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Move focus too, so keyboard and screen reader users land on the line they asked for.
    li?.focus({ preventScroll: true });
  }

  async function regrade() {
    if (!view?.scenario || regrading) return;
    setRegrading(true);
    setRegradeMsg(null);
    const headers = { "Content-Type": "application/json" };
    try {
      // Browser sessions are graded here and saved locally. Server sessions are graded by the server from the
      // transcript it stored, and it saves the result; the scenario is sent only for custom personas it lacks.
      const res = view.local
        ? await fetch("/api/evaluate-call", { method: "POST", headers, body: JSON.stringify({ scenario: view.scenario, transcript: view.transcript }) })
        : await fetch(`/api/transcripts/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers, body: JSON.stringify({ scenario: view.scenario }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Re-grading failed. Try again in a minute.");
      const next: Evaluation = view.local ? data : data.evaluation;
      // The grader falls back to rules when the model call fails; keep the current grade instead of swapping in another estimate.
      if (next?.method !== "llm") throw new Error("AI grading didn't work this time, so your grade wasn't changed. Try again in a minute.");
      if (view.local) updateLocalEvaluation(sessionId, next);
      setView({ ...view, evaluation: next });
      setRegradeMsg({ ok: true, text: `Re-graded by ${graderLabel(next)}.` });
    } catch (e) {
      setRegradeMsg({ ok: false, text: e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : e instanceof Error ? e.message : "Re-grading failed." });
    } finally {
      setRegrading(false);
    }
  }

  if (error && !view) {
    const missing = error === NOT_FOUND || error === NOT_LOCAL;
    return (
      <div className="deck min-h-screen">
        <div className="page pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-10">
          <div className="panel mx-auto max-w-xl">
            <EmptyState as="h1" tone="alert" icon={missing ? FileQuestion : WifiOff} title={missing ? "This debrief isn't here" : "Couldn't load this debrief"}
              action={<>
                {!missing && <button type="button" className="btn-primary" onClick={() => { setError(""); setAttempt((n) => n + 1); }}><RefreshCw size={16} strokeWidth={1.75} aria-hidden /> Try again</button>}
                <Link href="/dashboard" className="btn-ghost">Back to progress</Link>
                {missing && <Link href="/trainer" className="btn-primary"><RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Start a call</Link>}
              </>}>
              <span role="alert">{error}</span>
            </EmptyState>
          </div>
        </div>
      </div>
    );
  }
  if (!view) return <div className="deck min-h-screen"><DebriefSkeleton /></div>;

  const spoke = view.transcript.some((t) => t.role === "user" && t.text.trim());
  const gs = ev ? goalStatusOf(ev) : null;
  const stamp = gs && { achieved: ["Goal achieved", "border-ok text-ok"], partial: ["Goal partly met", "border-signal text-signal"], not_achieved: ["Goal missed", "border-caution text-caution"] }[gs];
  const heuristic = ev && (ev.method !== "llm" || isLegacyGrader(ev));
  // Browser sessions re-grade a rules-based grade only. Server sessions follow the PATCH rule: managers and admins on
  // other people's calls always, anyone on their own call only while it has no AI grade. The server checks again and
  // its 403 shows below the button.
  const mayRegrade = view.local
    ? !!heuristic
    : canRegrade({ managesOrg: canManageTeam(user?.role, !!user?.isPlatformAdmin), ownsSession: !!user && view.ownerId === user.id }, ev);
  const aiGradeLocked = !view.local && !mayRegrade && isAiGrade(ev);
  // Shown with the grade, or with the "wasn't graded" banner when a server call was saved without one.
  const regradeButton = mayRegrade && view.scenario && capabilities?.llm && (
    <button type="button" className="btn-ghost btn-sm w-full print:hidden" onClick={regrade} aria-disabled={regrading} aria-busy={regrading}>{regrading ? <Loader2 size={13} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <RefreshCw size={13} strokeWidth={1.75} aria-hidden />} {regrading ? "Re-grading" : "Re-grade with AI"}</button>
  );
  const regradeStatus = regradeMsg && <p ref={regradeMsgRef} tabIndex={-1} role={regradeMsg.ok ? "status" : "alert"} className={`text-xs outline-none ${regradeMsg.ok ? "text-ok" : "text-alert"}`}>{regradeMsg.text}</p>;
  // AI grading failed for this call: a retry panel replaces the score and letter grade. Not gated on capabilities.llm,
  // so the rep can always ask; the server answers with a clear message if grading is still unavailable.
  const headline = debriefHeadline(ev);
  const retryGradingButton = mayRegrade && view.scenario && (
    <button type="button" className="btn-primary w-full print:hidden" onClick={regrade} aria-disabled={regrading} aria-busy={regrading}>
      {regrading ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <RefreshCw size={16} strokeWidth={1.75} aria-hidden />}
      {regrading ? "Grading" : "Retry grading"}
    </button>
  );
  // A long call is graded on its opening turns, and ev.note says how many.
  const gradedOn = ev && wasCapped(ev.note) ? "" : " on the full transcript";
  const cues = view.coach?.cues ?? [];
  const cueTurns = new Map(cues.map((c) => [c.triggerTurn, c]));
  // The persona id lets the trainer open the right buyer even when this call can't be loaded there.
  const retryHref = retry ? `/trainer?retry=${encodeURIComponent(sessionId)}&turn=${retry.turn}${view.scenarioId ? `&scenario=${encodeURIComponent(view.scenarioId)}` : ""}` : "/trainer";

  return (
    <div className="deck min-h-screen">
      {/* Below md the fixed bottom tab bar (56 px plus the safe-area inset) overlays the page end, so the content pads past it. */}
      <div className="page enter space-y-6 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Black-box debrief</p>
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{view.title}</h1>
            <p className="mt-1 font-mono text-xs text-ink-muted">{new Date(view.createdAt).toLocaleString()} · {formatDuration(view.durationSeconds)} · {view.transcript.length} turns{view.coach ? ` · coach ${view.coach.mode}` : ""}{view.voiceUsed ? ` · ${voiceLabel(view.voiceUsed)}` : ""}</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto print:hidden">
            <button className="btn-ghost max-sm:!min-h-[44px] max-sm:!px-3" onClick={() => window.print()} aria-label="Print debrief" title="Print debrief"><Printer size={16} strokeWidth={1.75} aria-hidden /><span className="hidden sm:inline">Print</span></button>
            <Link href={view.scenarioId ? `/trainer?scenario=${encodeURIComponent(view.scenarioId)}` : "/trainer"} className="btn-ghost max-sm:min-h-[44px] max-sm:flex-1"><RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Practice again</Link>
            {/* /demo redirects to the booking site, so a plain link. */}
            {ev && spoke && firstGraded && <a href="/demo" className="btn-ghost"><CalendarDays size={16} strokeWidth={1.75} aria-hidden /> Book a demo for your team</a>}
            {retry && <Link href={retryHref} className="btn-primary max-sm:order-first max-sm:min-h-[44px] max-sm:w-full"><RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Retry from turn {retry.turn}</Link>}
          </div>
        </div>
        {error && <p className="banner-warn">{error}</p>}

        {view.competition && (
          <section className={`panel flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5 print:hidden ${view.competition.qualified ? "border-primary/40 bg-primary-soft/25" : "border-caution/40 bg-caution-soft/25"}`} aria-label="Championship result">
            <div className="flex min-w-0 items-start gap-3">
              <Trophy size={20} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${view.competition.qualified ? "text-primary" : "text-caution"}`} aria-hidden />
              <div className="min-w-0">
                <p className="font-mono text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                  Official Championship · Attempt {view.competition.attemptNumber} of {COMPETITION_MAX_ATTEMPTS} · {view.competition.trackLabel}
                </p>
                {view.competition.qualified ? (
                  <p className="mt-0.5 font-heading text-base font-bold text-ink">
                    Ranked #{view.competition.overallRank ?? 1} overall
                    {view.competition.industryRank ? ` (#${view.competition.industryRank} in ${view.competition.trackLabel})` : ""}
                  </p>
                ) : (
                  <>
                    <p className="mt-0.5 font-heading text-base font-bold text-ink">Attempt did not qualify for the leaderboard</p>
                    {view.competition.message && <p className="mt-0.5 text-xs text-ink-soft">{view.competition.message}</p>}
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {view.competition.qualified && (
                <Link href={`/compete/card/${encodeURIComponent(view.competition.shareToken)}`} className="btn-primary btn-sm">
                  <Share2 size={14} strokeWidth={1.75} aria-hidden /> Share score card
                </Link>
              )}
              <Link href="/compete" className="btn-ghost btn-sm">View leaderboard</Link>
            </div>
          </section>
        )}

        {!spoke ? (
          <div className="panel p-6 text-center sm:p-8">
            <h2 className="text-lg font-bold">Nothing to grade yet</h2>
            <p className="mx-auto mt-2 max-w-md text-ink-soft">You didn’t say anything on this call, so there’s no score. Start a new call and try your opening line.</p>
            <Link href="/trainer" className="btn-primary mt-4"><RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Practice again</Link>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_380px]">
            {/* Score column */}
            <aside className="space-y-4 lg:sticky lg:top-[calc(var(--header-h,3.5rem)+1rem)] lg:self-start">
              {headline.kind === "catching_up" ? (
                <section className="panel space-y-3 p-5" aria-labelledby="catching-up-h">
                  <div className="flex items-start gap-3">
                    <Clock size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-signal" aria-hidden />
                    <div className="min-w-0">
                      <h2 id="catching-up-h" className="font-heading text-lg font-bold">Grading is catching up</h2>
                      <p className="mt-1 text-sm text-ink-soft">{"Your transcript is saved. AI grading didn't finish for this call. Retry to grade it now."}</p>
                    </div>
                  </div>
                  {retryGradingButton}
                  {mayRegrade && !view.scenario && (
                    <p className="text-xs text-ink-muted print:hidden">To retry, open this debrief in the browser where you created this persona.</p>
                  )}
                  {regradeStatus}
                  <p className="border-t border-line pt-3 font-mono text-[11px] text-ink-muted">{headline.estimate}</p>
                </section>
              ) : ev ? (
                <div className="panel flex flex-col items-center gap-3 p-5 text-center">
                  <ScoreRing score={ev.overallScore} grade={ev.grade} />
                  <p className="font-heading text-lg font-bold">{scoreLabel(ev.overallScore)}</p>
                  {stamp && <span className={`-rotate-2 rounded-md border-2 px-3 py-1 font-mono text-xs font-bold uppercase tracking-[0.14em] ${stamp[1]}`}>{stamp[0]}</span>}
                  <div className="w-full space-y-2 border-t border-line pt-3 text-left">
                    <p className="flex items-center gap-2 text-xs">
                      <span className={`lamp ${heuristic ? "lamp-caution" : "lamp-ok"}`} aria-hidden />
                      {heuristic ? <span><strong>Estimate.</strong> Rules-based grade, not AI-graded.</span>
                        : <span>Graded by AI{gradedOn}</span>}
                    </p>
                    {regradeButton}
                    {aiGradeLocked && capabilities?.llm && (
                      <p className="text-xs text-ink-muted print:hidden">Think this grade is wrong? Ask your manager to re-grade it.</p>
                    )}
                    {heuristic && capabilities && !capabilities.llm && (
                      <p className="text-xs text-ink-muted print:hidden">AI grading is off on this server. <Link href="/settings/models" className="font-semibold text-primary underline-offset-2 hover:underline">See how to turn it on</Link></p>
                    )}
                    {regradeStatus}
                    {ev.note && <p className="text-xs text-ink-muted">{ev.note}</p>}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="banner-warn">This call wasn’t graded. Your transcript is saved.{regradeButton ? " Re-grade it with AI below." : ""}</p>
                  {regradeButton}
                  {regradeStatus}
                </div>
              )}

              {retry && (
                <div className="panel p-4">
                  <h2 className="label">Retry point</h2>
                  <p className="text-sm"><strong>{retry.criterion}</strong> was your weakest area ({retry.score}). Pick the call back up at turn {retry.turn} and try it again.</p>
                  <Link href={retryHref} className="btn-primary btn-sm mt-3 w-full print:hidden"><RotateCcw size={13} strokeWidth={1.75} aria-hidden /> Retry from turn {retry.turn}</Link>
                </div>
              )}

              {view.coach && (
                <div className="panel p-4">
                  <h2 className="label">Live coach</h2>
                  <p className="text-sm"><span className="mono">{cues.length}</span> cues · <span className="mono">{cues.filter((c) => c.used).length}</span> used · {view.coach.mode} mode</p>
                  <p className="mt-1 font-mono text-[11px] text-ink-muted">{view.coach.source === "llm" ? "AI" : "rules-based"}{view.coach.p50Ms != null ? ` · p50 ${(view.coach.p50Ms / 1000).toFixed(1)}s` : ""}</p>
                </div>
              )}

              {drill && (
                <div className="panel p-4 print:hidden">
                  <h2 className="label">Next drill</h2>
                  <div className="flex items-center gap-3">
                    <PersonaAvatar scenario={drill} size={40} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{drill.aiPersona.name}</p>
                      <p className="line-clamp-2 text-xs text-ink-muted">{drill.title}</p>
                    </div>
                  </div>
                  <Link href={`/trainer?scenario=${encodeURIComponent(drill.id)}`} className="btn-ghost btn-sm mt-3 w-full">Pre-flight <ArrowRight size={13} strokeWidth={1.75} aria-hidden /></Link>
                </div>
              )}
            </aside>

            {/* Analysis column */}
            <div className="min-w-0 space-y-6">
              <section className="panel p-4 sm:p-5" aria-labelledby="strip-h">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="strip-h" className="label !mb-0">Moment strip · click a turn</h2>
                  <p className="flex items-center gap-1 font-mono text-[10px] text-ink-muted"><ChevronDown size={12} strokeWidth={1.75} className="text-caution" aria-hidden />coach cue · colored = scored evidence</p>
                </div>
                {/* Long calls scroll inside the strip instead of widening the page. Each turn's target is the full strip height and
                    covers the gap beside its bar: at least 24 px wide on phones, 12 px from sm up. */}
                <div className="scroll-thin -mx-1 overflow-x-auto px-1 pb-1">
                  <div className="flex h-16 min-w-full" role="list">
                    {view.transcript.map((t, i) => {
                      const line = i + 1;
                      const crits = lineCriteria[line] ?? [];
                      const me = t.role === "user";
                      const cue = cueTurns.get(line);
                      return (
                        <div key={i} role="listitem" className="flex min-w-[24px] flex-1 sm:min-w-[12px]">
                        <button type="button" onClick={() => jump(line)} title={`T${line} · ${me ? "You" : view.callerName}${crits.length ? ` · ${crits.map((id) => ev?.criteria.find((c) => c.id === id)?.name).join(", ")}` : ""}${cue ? ` · ${CUE_LABELS[cue.type]} cue` : ""}`}
                          aria-label={`Turn ${line}, ${me ? "you" : view.callerName}${cue ? `, ${CUE_LABELS[cue.type]} cue` : ""}`}
                          className="group flex w-full flex-col justify-end px-[1.5px]">
                          <span className={`relative w-full rounded-sm transition group-hover:brightness-125 ${focus === line ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : ""}`}
                            style={{ height: me ? 40 : 18, background: crits.length ? critColor[crits[0]] : me ? "rgb(var(--ink-muted) / .45)" : "rgb(var(--line))" }}>
                            {cue && <ChevronDown size={12} strokeWidth={1.75} className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-caution" aria-hidden />}
                          </span>
                        </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {ev && (
                  <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                    {ev.criteria.map((c) => <li key={c.id} className="flex items-center gap-1.5 text-[11px] text-ink-soft"><span className="h-2 w-2 rounded-sm" style={{ background: critColor[c.id] }} aria-hidden />{c.name}</li>)}
                  </ul>
                )}
              </section>

              {ev && (
                <>
                  <section className="panel p-4 sm:p-5" aria-labelledby="verdict-h">
                    <h2 id="verdict-h" className="label">Verdict</h2>
                    <p className="text-[15px] leading-relaxed text-ink-soft">{friendlySummary(ev)}</p>
                    <p className="mt-3 text-sm text-ink-muted">{ev.goalAchievement.explanation}</p>
                  </section>

                  <div className="grid gap-4 md:grid-cols-2">
                    <section className="panel p-4">
                      <h2 className="label flex items-center gap-2"><CheckCircle2 size={14} strokeWidth={1.75} className="text-ok" aria-hidden /> Strengths <span className="normal-case tracking-normal">{ev.strengths.length}</span></h2>
                      <ul className="space-y-1.5 text-sm text-ink-soft">{ev.strengths.length ? ev.strengths.map((x, i) => <li key={i}>{x}</li>) : <li>Nothing stood out this time. Keep practicing and your strengths will show up here.</li>}</ul>
                    </section>
                    <section className="panel p-4">
                      <h2 className="label flex items-center gap-2"><TrendingUp size={14} strokeWidth={1.75} className="text-caution" aria-hidden /> Improve <span className="normal-case tracking-normal">{ev.improvements.length}</span></h2>
                      <ul className="space-y-1.5 text-sm text-ink-soft">{ev.improvements.length ? ev.improvements.map((x, i) => <li key={i}>{x}</li>) : <li>Nothing major to fix. Nice work.</li>}</ul>
                    </section>
                  </div>

                  <section aria-labelledby="crit-h" className="space-y-3">
                    <h2 id="crit-h" className="label !mb-0">Score by criterion</h2>
                    {ev.criteria.map((c) => {
                      const t = tone(c.score);
                      return (
                        <article key={c.id} className="panel p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="flex items-center gap-2 text-[15px] font-semibold"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: critColor[c.id] }} aria-hidden />{c.name}</h3>
                              <p className="mono mt-0.5 pl-[18px] text-[11px] text-ink-muted">weight {Math.round(c.weight)}%</p>
                            </div>
                            <span className={`mono shrink-0 text-2xl font-semibold leading-none ${TEXT[t]}`}>{c.score}</span>
                          </div>
                          <div className="tape mt-2" role="meter" aria-label={`${c.name} score`} aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={100}>
                            <span className={BG[t]} style={{ width: `${c.score}%` }} />
                          </div>
                          <p className="mt-3 text-sm text-ink-soft">{friendlyRationale(c.rationale)}</p>
                          {c.evidence.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {c.evidence.map((e, i) => (
                                <button key={i} onClick={() => e.line && jump(e.line)} className="quote flex max-w-full items-start gap-2 text-left hover:border-signal">
                                  <Quote size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                                  <span className="min-w-0"><span className="italic">&ldquo;{e.quote}&rdquo;</span> <span className="mono whitespace-nowrap text-[11px] text-ink-muted">{e.speaker === "trainee" ? "You" : view.callerName}{e.line ? ` · T${e.line}` : ""}</span></span>
                                </button>
                              ))}
                            </div>
                          ) : <p className="mt-3 text-xs text-ink-muted">No direct transcript evidence found for this criterion.</p>}
                        </article>
                      );
                    })}
                  </section>
                </>
              )}

              {view.supervisorNotes && <section className="panel p-4" aria-labelledby="notes-h"><h2 id="notes-h" className="label">Supervisor notes</h2><p className="whitespace-pre-wrap text-sm text-ink-soft">{view.supervisorNotes}</p></section>}
            </div>

            {/* Transcript column */}
            <section className="panel min-w-0 lg:col-span-2 xl:col-span-1 xl:sticky xl:top-[calc(var(--header-h,3.5rem)+1rem)] xl:max-h-[calc(100vh-var(--header-h,3.5rem)-2rem)] xl:self-start xl:overflow-hidden" aria-labelledby="tx-h">
              <h2 id="tx-h" className="label !mb-0 border-b border-line px-4 py-3">Transcript</h2>
              <ol className="scroll-thin space-y-1 p-2 xl:max-h-[calc(100vh-var(--header-h,3.5rem)-6rem)] xl:overflow-y-auto">
                {view.transcript.map((t, i) => {
                  const line = i + 1;
                  const me = t.role === "user";
                  const cue = cueTurns.get(line);
                  const Icon = cue ? CUE_ICON[cue.type] : null;
                  return (
                    <li key={i} ref={(el) => { lineRefs.current[line] = el; }} tabIndex={-1} className={`rounded-md px-2.5 py-2 transition-colors ${focus === line ? "bg-primary-soft ring-1 ring-primary/60" : ""}`}>
                      <p className={`font-mono text-[10.5px] uppercase tracking-wide ${me ? "text-primary" : "text-ink-muted"}`}>T{line} · {me ? "You" : view.callerName}
                        {(lineCriteria[line] ?? []).map((id) => <span key={id} className="ml-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: critColor[id] }} title={ev?.criteria.find((c) => c.id === id)?.name} />)}
                      </p>
                      <p className={`mt-0.5 text-sm leading-relaxed ${me ? "text-ink" : "text-ink-soft"}`}>{t.text}</p>
                      {cue && Icon && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-caution"><Icon size={12} strokeWidth={1.75} aria-hidden /> {CUE_LABELS[cue.type]} cue: {cue.title}{cue.used ? " · used" : ""}</p>}
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
        )}

        {ev && (
          <p className="border-t border-line pt-4 font-mono text-[11px] text-ink-muted">
            Grader: {graderLabel(ev)} · version {ev.graderVersion ?? "legacy"}{ev.evaluatedAt ? ` · graded ${new Date(ev.evaluatedAt).toLocaleString()}` : ""} · evidence quotes are checked against the transcript before they are shown
          </p>
        )}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Printer, RotateCcw, Quote, CheckCircle2, TrendingUp, Target, ArrowRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getLocalSession } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import { goalStatusOf, isLegacyGrader, scoreLabel, stripGraderNote } from "@/lib/grader-types";
import { formatDuration } from "@/lib/format";
import { PageSkeleton } from "@/components/ui/Skeleton";

interface View {
  title: string;
  industry?: string;
  createdAt: string;
  durationSeconds: number;
  transcript: { role: string; text: string }[];
  evaluation: Evaluation | null;
  supervisorNotes?: string | null;
  callerName: string;
}

/** Older heuristic sessions stored keyword-stem rationales; never show those to users. */
const friendlyRationale = (raw: string) => {
  const r = stripGraderNote(raw);
  return /^Keyword match:/.test(r) ? r.replace(/^Keyword match: the trainee touched on (\d+) of (\d+) themes from this criterion.*$/, "You addressed $1 of $2 expected points for this area.") : r;
};
const friendlySummary = (ev: Evaluation) =>
  /^Heuristic score/.test(ev.summary) ? `Automatic estimate: ${ev.overallScore}/100, based on how many of the rubric's topics you covered.` : ev.summary;

const scoreColor = (n: number) => (n >= 80 ? "bg-accent" : n >= 60 ? "bg-primary" : "bg-amber-500");
/** Text-safe (AA on white) counterpart of scoreColor. */
const scoreText = (n: number) => (n >= 80 ? "text-accent-dark" : n >= 60 ? "text-primary" : "text-amber-800");
const ringStroke = (n: number) => (n >= 80 ? "#14B8A6" : n >= 60 ? "#1D4ED8" : "#F59E0B");

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="relative h-40 w-40 shrink-0" role="img" aria-label={`Grade ${grade}, ${score} percent, ${scoreLabel(score)}`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="#E2E8F0" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={ringStroke(score)} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, score)) / 100)} className="transition-[stroke-dashoffset] duration-1000 ease-out" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className={`font-heading text-5xl font-bold leading-none ${scoreText(score)}`}>{grade}</span>
        <span className="mt-1 text-sm font-semibold text-ink">{score}%</span>
      </div>
    </div>
  );
}

export default function DebriefPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { isAuthenticated, isLoading, capabilities } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (sessionId.startsWith("local-")) {
      const s = getLocalSession(sessionId);
      if (!s) { setError("This session isn’t stored in this browser."); return; }
      setView({ title: s.scenario.title, industry: s.scenario.industry, createdAt: s.createdAt, durationSeconds: s.durationSeconds, transcript: s.transcript, evaluation: s.evaluation, callerName: s.scenario.aiPersona.name });
      return;
    }
    if (!isAuthenticated) { router.replace("/login"); return; }
    fetch(`/api/transcripts/${sessionId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Session not found." : "Could not load this session.");
        const { session } = await r.json();
        setView({ title: session.scenarioTitle ?? session.scenarioId, industry: session.scenarioCategory, createdAt: session.createdAt, durationSeconds: session.durationSeconds, transcript: session.transcript, evaluation: session.evaluation, supervisorNotes: session.supervisorNotes, callerName: "Caller" });
      })
      .catch((e) => setError(e.message));
  }, [sessionId, capabilities, isLoading, isAuthenticated, router]);

  if (error) return <div className="page"><p className="banner-warn">{error} <Link className="font-semibold underline" href="/dashboard">Back to dashboard</Link></p></div>;
  if (!view) return <PageSkeleton rows={2} />;
  const ev = view.evaluation;
  const spoke = view.transcript.some((t) => t.role === "user" && t.text.trim());
  const strengths = ev ? (ev.strengths.length ? ev.strengths : ev.criteria.filter((c) => c.score >= 70).map((c) => `${c.name}: you handled this well.`)) : [];
  const improvements = ev ? (ev.improvements.length ? ev.improvements : ev.criteria.filter((c) => c.score < 70).map((c) => `${c.name}: practise this a bit more.`)) : [];

  const weakest = ev ? [...ev.criteria].sort((x, y) => x.score - y.score)[0] : undefined;

  return (
    <div className="page enter space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Call debrief</p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{view.title}</h1>
          <p className="mt-1 text-sm text-ink-muted">{new Date(view.createdAt).toLocaleString()} · {formatDuration(view.durationSeconds)} · {view.transcript.length} turns</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <button className="btn-ghost" onClick={() => window.print()}><Printer size={16} /> Print</button>
          <Link href="/trainer" className="btn-primary"><RotateCcw size={16} /> Practice again</Link>
        </div>
      </div>

      {!spoke ? (
        <div className="card text-center">
          <h2 className="text-lg font-bold">Nothing to grade yet</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-soft">You didn’t say anything on this call, so there’s no score. Start a new call and try your opening line.</p>
          <Link href="/trainer" className="btn-primary mt-4"><RotateCcw size={16} /> Practice again</Link>
        </div>
      ) : !ev ? (
        <p className="banner-warn">This call wasn’t graded. Your transcript is saved below.</p>
      ) : (
        <>
          {ev.note && <p className="banner-warn">{ev.note}</p>}
          <div className="card flex flex-col items-center gap-6 sm:flex-row sm:gap-8">
            <div className="flex flex-col items-center gap-2">
              <ScoreRing score={ev.overallScore} grade={ev.grade} />
              <p className="font-heading text-lg font-bold">{scoreLabel(ev.overallScore)}</p>
              <span className="badge bg-slate-100 text-ink-soft">{isLegacyGrader(ev) ? "Legacy grader" : ev.method === "llm" ? "AI-graded" : "Automatic estimate"}</span>
            </div>
            <div className="min-w-0 flex-1 space-y-4">
              <p className="text-base leading-relaxed text-ink-soft">{friendlySummary(ev)}</p>
              {(() => {
                const gs = goalStatusOf(ev);
                const tone = { achieved: "bg-accent-soft text-ink", partial: "bg-blue-50 text-blue-950", not_achieved: "bg-amber-50 text-amber-900" }[gs];
                const label = { achieved: "Goal achieved", partial: "Goal partially achieved", not_achieved: "Goal not achieved" }[gs];
                return (
                  <p className={`flex items-start gap-2 rounded-xl p-3 text-sm ${tone}`}>
                    <Target size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <span><strong>{label}.</strong> {ev.goalAchievement.explanation}</span>
                  </p>
                );
              })()}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="card border-t-4 border-t-accent">
              <h2 className="flex items-center gap-2 text-base font-bold"><CheckCircle2 size={18} className="text-accent-dark" aria-hidden /> Strengths</h2>
              <ul className="mt-3 space-y-2 text-sm text-ink-soft">
                {strengths.length ? strengths.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />{x}</li>) : <li>Nothing stood out this time. Keep practising and your strengths will show up here.</li>}
              </ul>
            </div>
            <div className="card border-t-4 border-t-amber-500">
              <h2 className="flex items-center gap-2 text-base font-bold"><TrendingUp size={18} className="text-amber-700" aria-hidden /> Areas to improve</h2>
              <ul className="mt-3 space-y-2 text-sm text-ink-soft">
                {improvements.length ? improvements.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />{x}</li>) : <li>Nothing major to fix. Nice work.</li>}
              </ul>
            </div>
          </div>

          {weakest && (
            <div className="flex flex-col gap-3 rounded-2xl bg-ink p-5 text-white sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-accent">Suggested next step</p>
                <p className="mt-1 text-base">
                  {weakest.score >= 85 ? "Strong call. Raise the bar by trying a harder scenario." : <>Run this scenario again and focus on <strong>{weakest.name}</strong> ({weakest.score}%).</>}
                </p>
              </div>
              <Link href="/trainer" className="btn-accent btn-pill shrink-0 print:hidden">Practice again <ArrowRight size={16} /></Link>
            </div>
          )}

          <h2 className="pt-2 text-xl font-bold">Score by criterion</h2>
          <div className="space-y-4">
            {ev.criteria.map((c) => (
              <div key={c.id} className="card">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold">{c.name} <span className="ml-1 whitespace-nowrap text-xs font-normal text-ink-muted">weight {Math.round(c.weight)}%</span></h3>
                  <span className={`font-heading text-xl font-bold ${scoreText(c.score)}`}>{c.score}<span className="text-sm">/100</span></span>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={`${c.name} score`} aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={100}>
                  <div className={`h-full rounded-full transition-[width] duration-700 ease-out ${scoreColor(c.score)}`} style={{ width: `${c.score}%` }} />
                </div>
                <p className="mt-3 text-sm text-ink-soft">{friendlyRationale(c.rationale)}</p>
                {c.evidence.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {c.evidence.map((e, i) => (
                      <blockquote key={i} className="quote">
                        <Quote size={14} className="mb-1 text-accent-dark" aria-hidden />
                        <p className="italic">“{e.quote}”</p>
                        <footer className="mt-1 text-xs text-ink-muted">{e.speaker === "trainee" ? "You" : view.callerName}{e.line ? ` · line ${e.line} of the transcript` : ""}</footer>
                      </blockquote>
                    ))}
                  </div>
                ) : <p className="mt-3 text-xs text-ink-muted">No direct transcript evidence found for this criterion.</p>}
              </div>
            ))}
          </div>
        </>
      )}

      {view.supervisorNotes && <div className="card"><h3 className="font-semibold">Supervisor notes</h3><p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{view.supervisorNotes}</p></div>}

      <div className="card">
        <h2 className="text-lg font-bold">Transcript</h2>
        <div className="mt-4 space-y-3 text-sm">
          {view.transcript.map((t, i) => {
            const me = t.role === "user";
            return (
              <div key={i} className={`flex ${me ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] sm:max-w-[70%] ${me ? "text-right" : ""}`}>
                  <span className="mb-1 block px-1 text-xs text-ink-muted">{i + 1} · {me ? "You" : view.callerName}</span>
                  <p className={`inline-block rounded-2xl px-4 py-2.5 text-left leading-relaxed ${me ? "rounded-br-md bg-primary text-white" : "rounded-bl-md bg-slate-100 text-ink"}`}>{t.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

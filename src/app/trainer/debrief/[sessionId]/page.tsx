"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Printer, RotateCcw, Quote } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getLocalSession } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";

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

const scoreColor = (n: number) => (n >= 80 ? "bg-accent" : n >= 60 ? "bg-primary" : "bg-amber-500");

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
  if (!view) return <div className="page text-ink-muted">Loading…</div>;
  const ev = view.evaluation;

  return (
    <div className="page space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-ink-muted">Debrief · {new Date(view.createdAt).toLocaleString()} · {Math.floor(view.durationSeconds / 60)}m {view.durationSeconds % 60}s</p>
          <h1 className="text-2xl font-bold sm:text-3xl">{view.title}</h1>
        </div>
        <div className="flex gap-2 print:hidden">
          <button className="btn-ghost" onClick={() => window.print()}><Printer size={16} /> Print</button>
          <Link href="/trainer" className="btn-primary"><RotateCcw size={16} /> Practice again</Link>
        </div>
      </div>

      {!ev ? (
        <p className="banner-warn">This session has no evaluation.</p>
      ) : (
        <>
          {ev.note && <p className="banner-warn">{ev.note}</p>}
          <div className="card grid gap-6 sm:grid-cols-[180px_1fr] sm:items-center">
            <div className="text-center">
              <div className="font-heading text-6xl font-bold text-primary">{ev.overallScore}</div>
              <div className="mt-1 text-sm text-ink-muted">out of 100 · grade <strong className="text-ink">{ev.grade}</strong></div>
              <span className="badge mt-2 bg-slate-100 text-ink-soft">{ev.method === "llm" ? "AI-graded" : "Heuristic"}</span>
            </div>
            <div>
              <p className="text-ink-soft">{ev.summary}</p>
              <p className="mt-3 text-sm"><strong>Goal {ev.goalAchievement.achieved ? "achieved" : "not achieved"}.</strong> {ev.goalAchievement.explanation}</p>
            </div>
          </div>

          <h2 className="text-xl font-bold">Rubric breakdown</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {ev.criteria.map((c) => (
              <div key={c.id} className="card">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold">{c.name}</h3>
                  <span className="font-heading text-lg font-bold">{c.score}</span>
                </div>
                <p className="text-xs text-ink-muted">Weight {Math.round(c.weight)}%</p>
                <div className="mt-2 h-2 rounded-full bg-slate-100"><div className={`h-2 rounded-full ${scoreColor(c.score)}`} style={{ width: `${c.score}%` }} /></div>
                <p className="mt-3 text-sm text-ink-soft">{c.rationale}</p>
                {c.evidence.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {c.evidence.map((e, i) => (
                      <li key={i} className="flex gap-2 rounded-xl bg-slate-50 p-3 text-sm">
                        <Quote size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                        <span><em>“{e.quote}”</em><span className="block text-xs text-ink-muted">{e.speaker === "trainee" ? "You" : view.callerName} · evidence for “{c.name}”</span></span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-xs text-ink-muted">No direct transcript evidence found for this criterion.</p>}
              </div>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="card"><h3 className="font-semibold">Strengths</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">{ev.strengths.length ? ev.strengths.map((s, i) => <li key={i}>{s}</li>) : <li>None identified.</li>}</ul></div>
            <div className="card"><h3 className="font-semibold">Work on</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">{ev.improvements.length ? ev.improvements.map((s, i) => <li key={i}>{s}</li>) : <li>Nothing flagged.</li>}</ul></div>
          </div>
        </>
      )}

      {view.supervisorNotes && <div className="card"><h3 className="font-semibold">Supervisor notes</h3><p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{view.supervisorNotes}</p></div>}

      <div className="card">
        <h2 className="text-lg font-bold">Transcript</h2>
        <div className="mt-3 space-y-2 text-sm">
          {view.transcript.map((t, i) => (
            <p key={i}><strong className={t.role === "user" ? "text-primary" : "text-ink"}>{t.role === "user" ? "You" : view.callerName}:</strong> {t.text}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

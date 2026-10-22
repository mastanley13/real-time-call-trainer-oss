"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Trash2, PhoneCall, ChevronRight, RotateCcw } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { useAuth } from "@/contexts/AuthContext";
import { formatDuration } from "@/lib/format";
import { deleteLocalSession, getLocalSession, listLocalSessions, resetDemoData, restoreLocalSession, type StoredSession } from "@/lib/sessionStore";

interface Row {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  score: number | null;
  grade: string | null;
  /** Sessions graded before versioning (keyword grader on the old scale). */
  legacy: boolean;
}

export default function DashboardPage() {
  const { isAuthenticated, isLoading, capabilities, user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const [undo, setUndo] = useState<{ session: StoredSession; title: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const removeRow = useCallback((r: Row) => {
    const session = getLocalSession(r.id);
    if (!session) return;
    deleteLocalSession(r.id);
    setRows((cur) => cur && cur.filter((x) => x.id !== r.id));
    setUndo({ session, title: r.title });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 6000); // after this the delete is final
  }, []);

  function undoDelete() {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    restoreLocalSession(undo.session);
    const s = undo.session;
    const row: Row = { id: s.id, title: s.scenario.title, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null, legacy: !!s.evaluation && !s.evaluation.graderVersion };
    setRows((cur) => (cur ? [...cur, row].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : cur));
    setUndo(null);
  }

  function resetDemo() {
    if (!window.confirm("Reset demo data? This clears all practice sessions and custom scenarios stored in this browser.")) return;
    resetDemoData();
    clearTimeout(undoTimer.current);
    setUndo(null);
    setRows([]);
  }

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    const local: Row[] = listLocalSessions().map((s) => ({ id: s.id, title: s.scenario.title, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null, legacy: !!s.evaluation && !s.evaluation.graderVersion }));
    if (capabilities.demoMode || !capabilities.database) { setRows(local); return; }
    fetch("/api/transcripts")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load sessions.");
        const { sessions } = await r.json();
        const remote: Row[] = sessions.map((s: { id: string; scenarioTitle: string | null; scenarioId: string; createdAt: string; durationSeconds: number; overallScore: number | null; grade: string | null; graderVersion: string | null }) => ({ id: s.id, title: s.scenarioTitle ?? s.scenarioId, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.overallScore, grade: s.grade, legacy: s.overallScore !== null && !s.graderVersion }));
        setRows([...remote, ...local].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch((e) => { setError(e.message); setRows(local); });
  }, [capabilities, isLoading, isAuthenticated, router]);

  const stats = useMemo(() => {
    const scored = (rows ?? []).filter((r) => r.score !== null && (showLegacy || !r.legacy)) as (Row & { score: number })[];
    return {
      count: rows?.length ?? 0,
      avg: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null,
      best: scored.length ? Math.max(...scored.map((r) => r.score)) : null,
      practised: formatDuration((rows ?? []).reduce((a, r) => a + r.durationSeconds, 0)),
    };
  }, [rows, showLegacy]);
  const legacyCount = (rows ?? []).filter((r) => r.legacy).length;

  if (!rows) return <PageSkeleton />;

  return (
    <div className="page enter space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Welcome{user?.firstName ? `, ${user.firstName}` : ""}</h1>
          <p className="text-ink-muted">Your practice history and progress.</p>
        </div>
        <Link href="/trainer" className="btn-primary"><Mic size={16} /> New practice call</Link>
      </div>
      {error && <p className="banner-warn">{error}</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[["Sessions", stats.count], ["Average score", stats.avg ?? "—"], ["Best score", stats.best ?? "—"], ["Time practised", stats.practised]].map(([k, v]) => (
          <div key={k as string} className="card card-hover !p-4 sm:!p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{k}</p>
            <p className="mt-1.5 font-heading text-3xl font-bold text-ink">{v}</p>
          </div>
        ))}
      </div>

      {legacyCount > 0 && (
        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={showLegacy} onChange={(e) => setShowLegacy(e.target.checked)} />
          <span>Include {legacyCount} legacy-grader session{legacyCount === 1 ? "" : "s"} in averages. They were scored with the old keyword grader on a different scale, so they’re excluded by default.</span>
        </label>
      )}

      <div className="card !p-0 overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={PhoneCall} title="No practice calls yet"><p>Run your first scenario and your scores, quotes and progress will show up here.</p><Link href="/trainer" className="btn-primary btn-pill mt-4"><Mic size={16} /> Start your first call</Link></EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="group flex items-center justify-between gap-3 p-4 transition-colors hover:bg-slate-50">
                <Link href={`/trainer/debrief/${r.id}`} className="min-w-0 flex-1 rounded-lg">
                  <p className="break-words font-semibold">{r.title}</p>
                  <p className="text-xs text-ink-muted">{new Date(r.createdAt).toLocaleString()} · {formatDuration(r.durationSeconds)}{r.id.startsWith("local-") ? " · this browser" : ""}</p>
                </Link>
                <span className={`badge ${r.score === null ? "bg-slate-100 text-ink-soft" : r.score >= 80 ? "bg-accent-soft text-accent-darker" : r.score >= 60 ? "bg-primary-soft text-primary" : "bg-amber-100 text-amber-900"}`}>{r.score !== null ? `${r.score} · ${r.grade}` : "Ungraded"}</span>
                {r.legacy && <span className="badge shrink-0 bg-slate-100 text-ink-soft">Legacy grader</span>}
                <ChevronRight size={16} className="hidden text-ink-muted sm:block" aria-hidden />
                {r.id.startsWith("local-") && (
                  <button
                    aria-label={`Delete session: ${r.title}, ${new Date(r.createdAt).toLocaleString()}`}
                    title="Delete session"
                    className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ink-muted hover:bg-slate-100 hover:text-red-700"
                    onClick={() => removeRow(r)}
                  ><Trash2 size={18} aria-hidden /><span>Delete</span></button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {capabilities?.demoMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line p-4 text-sm">
          <p className="text-ink-soft">Demo mode: sessions and custom scenarios live in this browser only.</p>
          <button className="btn-ghost" onClick={resetDemo}><RotateCcw size={16} /> Reset demo data</button>
        </div>
      )}

      {undo && (
        <div role="status" className="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-pop">
          <span className="min-w-0 break-words">Deleted “{undo.title}”.</span>
          <button className="shrink-0 rounded-lg px-3 py-1.5 font-semibold text-accent underline underline-offset-2 hover:bg-white/10" onClick={undoDelete}>Undo</button>
        </div>
      )}
    </div>
  );
}

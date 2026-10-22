"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Trash2, PhoneCall, ChevronRight, RotateCcw } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { isLegacyGrader } from "@/lib/grader-types";
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
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [undo, setUndo] = useState<{ session: StoredSession; title: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(undoTimer.current); clearTimeout(noticeTimer.current); }, []);

  const removeRow = useCallback((r: Row) => {
    const session = getLocalSession(r.id);
    if (!session) return;
    deleteLocalSession(r.id);
    setRows((cur) => cur && cur.filter((x) => x.id !== r.id));
    setUndo({ session, title: r.title });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 12000); // after this the delete is final
  }, []);

  function undoDelete() {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    restoreLocalSession(undo.session);
    const s = undo.session;
    const row: Row = { id: s.id, title: s.scenario.title, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null, legacy: isLegacyGrader(s.evaluation) };
    setRows((cur) => (cur ? [...cur, row].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : cur));
    setUndo(null);
  }

  function resetDemo() {
    setConfirmReset(false);
    resetDemoData();
    clearTimeout(undoTimer.current);
    setUndo(null);
    setRows([]);
    setNotice("Demo data reset.");
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 5000);
  }

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    const local: Row[] = listLocalSessions().map((s) => ({ id: s.id, title: s.scenario.title, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null, legacy: isLegacyGrader(s.evaluation) }));
    if (capabilities.demoMode || !capabilities.database) { setRows(local); return; }
    fetch("/api/transcripts")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load sessions.");
        const { sessions } = await r.json();
        const remote: Row[] = sessions.map((s: { id: string; scenarioTitle: string | null; scenarioId: string; createdAt: string; durationSeconds: number; overallScore: number | null; grade: string | null; graderVersion: string | null; graderMethod: string | null }) => ({ id: s.id, title: s.scenarioTitle ?? s.scenarioId, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.overallScore, grade: s.grade, legacy: s.overallScore !== null && !s.graderVersion && s.graderMethod !== "llm" }));
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
      practised: formatDuration((rows ?? []).filter((r) => showLegacy || !r.legacy).reduce((a, r) => a + r.durationSeconds, 0)),
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
              <li key={r.id} className="group flex flex-wrap items-center gap-x-3 gap-y-2 p-4 sm:flex-nowrap transition-colors hover:bg-slate-50">
                <Link href={`/trainer/debrief/${r.id}`} className="min-w-0 basis-full rounded-lg sm:basis-auto sm:flex-1">
                  <p className="break-words font-semibold">{r.title}</p>
                  <p className="text-xs text-ink-muted">{new Date(r.createdAt).toLocaleString()} · {formatDuration(r.durationSeconds)}{r.id.startsWith("local-") ? " · this browser" : ""}</p>
                </Link>
                <span className={`badge ${r.score === null ? "bg-slate-100 text-ink-soft" : r.score >= 80 ? "bg-accent-soft text-accent-darker" : r.score >= 60 ? "bg-primary-soft text-primary" : "bg-amber-100 text-amber-900"}`}>{r.score !== null ? `${r.score} · ${r.grade}` : "Ungraded"}</span>
                {r.legacy && <span className="badge shrink-0 bg-slate-100 text-ink-soft">Legacy grader</span>}
                <ChevronRight size={16} className="ml-auto hidden text-ink-muted sm:block" aria-hidden />
                {r.id.startsWith("local-") && (
                  <button
                    aria-label={`Delete session: ${r.title}, ${new Date(r.createdAt).toLocaleString()}`}
                    title="Delete session"
                    className="ml-auto inline-flex min-h-[44px] items-center sm:ml-0 justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-ink-muted hover:bg-slate-100 hover:text-red-700"
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
          <button className="btn-ghost" onClick={() => setConfirmReset(true)}><RotateCcw size={16} /> Reset demo data</button>
        </div>
      )}

      {confirmReset && <ConfirmDialog title="Reset demo data?" message="This clears all practice sessions and custom scenarios stored in this browser." confirmLabel="Reset" onConfirm={resetDemo} onCancel={() => setConfirmReset(false)} />}
      {notice && <div role="status" className="fixed inset-x-3 bottom-4 z-[60] mx-auto max-w-md rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-pop">{notice}</div>}
      {undo && (
        <div role="status" className="fixed inset-x-3 bottom-4 z-[60] mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-ink px-4 py-3 text-sm text-white shadow-pop">
          <span className="min-w-0 break-words">Deleted “{undo.title}”.</span>
          <button className="shrink-0 rounded-lg px-3 py-1.5 font-semibold text-accent underline underline-offset-2 hover:bg-white/10" onClick={undoDelete}>Undo</button>
        </div>
      )}
      {/* Reserve space under the content so the fixed toast never covers Reset/Delete controls. */}
      {(undo || notice) && <div aria-hidden className="h-28" />}
    </div>
  );
}

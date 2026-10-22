"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Mic, Trash2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { deleteLocalSession, listLocalSessions } from "@/lib/sessionStore";

interface Row {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  score: number | null;
  grade: string | null;
}

export default function DashboardPage() {
  const { isAuthenticated, isLoading, capabilities, user } = useAuth();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    const local: Row[] = listLocalSessions().map((s) => ({ id: s.id, title: s.scenario.title, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null }));
    if (capabilities.demoMode || !capabilities.database) { setRows(local); return; }
    fetch("/api/transcripts")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load sessions.");
        const { sessions } = await r.json();
        const remote: Row[] = sessions.map((s: { id: string; scenarioTitle: string | null; scenarioId: string; createdAt: string; durationSeconds: number; overallScore: number | null; grade: string | null }) => ({ id: s.id, title: s.scenarioTitle ?? s.scenarioId, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.overallScore, grade: s.grade }));
        setRows([...remote, ...local].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch((e) => { setError(e.message); setRows(local); });
  }, [capabilities, isLoading, isAuthenticated, router]);

  const stats = useMemo(() => {
    const scored = (rows ?? []).filter((r) => r.score !== null) as (Row & { score: number })[];
    return {
      count: rows?.length ?? 0,
      avg: scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null,
      best: scored.length ? Math.max(...scored.map((r) => r.score)) : null,
      minutes: Math.round((rows ?? []).reduce((a, r) => a + r.durationSeconds, 0) / 60),
    };
  }, [rows]);

  if (!rows) return <div className="page text-ink-muted">Loading…</div>;

  return (
    <div className="page space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Welcome{user?.firstName ? `, ${user.firstName}` : ""}</h1>
          <p className="text-ink-muted">Your practice history and progress.</p>
        </div>
        <Link href="/trainer" className="btn-primary"><Mic size={16} /> New practice call</Link>
      </div>
      {error && <p className="banner-warn">{error}</p>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[["Sessions", stats.count], ["Average score", stats.avg ?? "—"], ["Best score", stats.best ?? "—"], ["Minutes practised", stats.minutes]].map(([k, v]) => (
          <div key={k as string} className="card !p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{k}</p>
            <p className="mt-1 font-heading text-3xl font-bold text-primary">{v}</p>
          </div>
        ))}
      </div>

      <div className="card !p-0 overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-8 text-center text-ink-muted">No sessions yet. <Link href="/trainer" className="font-semibold text-primary">Run your first scenario</Link>.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 p-4">
                <Link href={`/trainer/debrief/${r.id}`} className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{r.title}</p>
                  <p className="text-xs text-ink-muted">{new Date(r.createdAt).toLocaleString()} · {Math.max(1, Math.round(r.durationSeconds / 60))} min{r.id.startsWith("local-") ? " · this browser" : ""}</p>
                </Link>
                <span className="badge bg-primary-soft text-primary">{r.score !== null ? `${r.score} · ${r.grade}` : "Ungraded"}</span>
                {r.id.startsWith("local-") && (
                  <button aria-label="Delete session" className="rounded-lg p-2 text-ink-muted hover:bg-slate-100" onClick={() => { deleteLocalSession(r.id); setRows(rows.filter((x) => x.id !== r.id)); }}><Trash2 size={16} /></button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

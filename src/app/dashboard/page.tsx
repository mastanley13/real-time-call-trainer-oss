"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Mic, PhoneCall, RotateCcw, Trash2 } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import AssignedToYou from "@/components/team/AssignedToYou";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { PersonaAvatar } from "@/components/ui/Persona";
import { isLegacyGrader } from "@/lib/grader-types";
import { useAuth } from "@/contexts/AuthContext";
import { formatDuration } from "@/lib/format";
import { listScenarios } from "@/lib/scenarioStore";
import { nextDrill } from "@/lib/debrief";
import { deleteLocalSession, getLocalSession, listLocalSessions, resetDemoData, restoreLocalSession, type StoredSession } from "@/lib/sessionStore";

interface Row {
  id: string;
  title: string;
  scenarioId?: string;
  role?: string;
  createdAt: string;
  durationSeconds: number;
  score: number | null;
  grade: string | null;
  method: "llm" | "heuristic" | null;
  /** Sessions graded before versioning (keyword grader on the old scale). */
  legacy: boolean;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
/** Local midnight `n` calendar days after `d` (negative goes back). Date arithmetic, not 24 h steps, so DST changes can't skip or repeat a day. */
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const toRow = (s: StoredSession): Row => ({
  id: s.id, title: s.scenario.title, scenarioId: s.scenario.id, role: s.scenario.role, createdAt: s.createdAt, durationSeconds: s.durationSeconds,
  score: s.evaluation?.overallScore ?? null, grade: s.evaluation?.grade ?? null, method: s.evaluation?.method ?? null, legacy: isLegacyGrader(s.evaluation),
});

/** Tiny line chart; values are drawn to one 0..max scale. */
function Sparkline({ values, max }: { values: (number | null)[]; max?: number }) {
  const w = 120, h = 32;
  const nums = values.map((v) => v ?? 0);
  const top = max ?? Math.max(1, ...nums);
  const pts = nums.map((v, i) => [(i / Math.max(1, nums.length - 1)) * w, h - 3 - (v / top) * (h - 6)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" aria-hidden preserveAspectRatio="none">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="rgb(var(--primary) / .1)" />
      <path d={d} fill="none" stroke="rgb(var(--primary))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill="rgb(var(--primary))" />}
    </svg>
  );
}

function TrendChart({ rows }: { rows: Row[] }) {
  const pts = rows.filter((r) => r.score !== null).slice(0, 20).reverse();
  const w = 640, h = 220, pl = 32, pr = 12, pt = 12, pb = 28;
  const x = (i: number) => pl + (i / Math.max(1, pts.length - 1)) * (w - pl - pr);
  const y = (v: number) => pt + (1 - v / 100) * (h - pt - pb);
  if (pts.length < 2) return <p className="flex h-[220px] items-center justify-center text-sm text-ink-muted">Your score trend appears after two graded calls.</p>;
  const d = pts.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.score!)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label={`Score trend over your last ${pts.length} graded calls, latest ${pts[pts.length - 1].score}`}>
      {[0, 50, 70, 90, 100].map((v) => (
        <g key={v}>
          <line x1={pl} x2={w - pr} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeDasharray={v === 0 || v === 100 ? "" : "3 4"} />
          <text x={pl - 8} y={y(v) + 4} textAnchor="end" className="fill-[rgb(var(--ink-muted))] font-mono text-[10px]">{v}</text>
        </g>
      ))}
      <path d={`${d} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="rgb(var(--primary) / .08)" />
      <path d={d} fill="none" stroke="rgb(var(--primary))" strokeWidth="2" />
      {pts.map((r, i) => (
        <circle key={r.id} cx={x(i)} cy={y(r.score!)} r={i === pts.length - 1 ? 4.5 : 3} fill={i === pts.length - 1 ? "rgb(var(--primary))" : "rgb(var(--surface))"} stroke="rgb(var(--primary))" strokeWidth="1.5">
          <title>{`${r.title}: ${r.score}`}</title>
        </circle>
      ))}
      <text x={pl} y={h - 8} className="fill-[rgb(var(--ink-muted))] font-mono text-[10px]">oldest</text>
      <text x={w - pr} y={h - 8} textAnchor="end" className="fill-[rgb(var(--ink-muted))] font-mono text-[10px]">latest</text>
    </svg>
  );
}

function Heatmap({ rows }: { rows: Row[] }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const counts = new Map<string, number>();
  for (const r of rows) { const k = dayKey(new Date(r.createdAt)); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const weeks = 26;
  const start = addDays(today, -((weeks - 1) * 7 + today.getDay()));
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  const level = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3);
  const fills = ["rgb(var(--sunken))", "rgb(var(--primary) / .35)", "rgb(var(--primary) / .65)", "rgb(var(--primary))"];
  const days = [...counts.values()].length;
  return (
    <div>
      {/* On phones the 26 weeks are wider than the panel. An rtl scroller starts at, and stays anchored to, the latest
          weeks through rotation and resizes; the calendar itself stays ltr, and mr-auto keeps it left-aligned when it fits. */}
      <div className="scroll-thin overflow-x-auto [direction:rtl]">
        <div className="mr-auto grid w-max grid-flow-col grid-rows-7 gap-[3px] [direction:ltr] [grid-auto-columns:13px]" role="img" aria-label={`Practice days over the last ${weeks} weeks: ${days} days with at least one call`}>
          {cells.map((d) => {
            const n = d > today ? -1 : counts.get(dayKey(d)) ?? 0;
            return <span key={d.toISOString()} className="h-[13px] w-[13px] rounded-[3px]" style={{ background: n < 0 ? "transparent" : fills[level(n)] }} title={n >= 0 ? `${d.toLocaleDateString()}: ${n} call${n === 1 ? "" : "s"}` : undefined} />;
          })}
        </div>
      </div>
      <p className="mt-3 text-sm text-ink-soft"><span className="mono font-semibold text-ink">{days}</span> practice day{days === 1 ? "" : "s"} in the last 6 months</p>
      <div className="mt-2 flex items-center justify-end gap-1.5 font-mono text-[10px] text-ink-muted">less {fills.map((f) => <span key={f} className="h-2.5 w-2.5 rounded-[2px]" style={{ background: f }} />)} more</div>
    </div>
  );
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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
    setRows((cur) => (cur ? [...cur, toRow(undo.session)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : cur));
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
    const local: Row[] = listLocalSessions().map(toRow);
    if (capabilities.demoMode || !capabilities.database) { setRows(local); return; }
    fetch("/api/transcripts")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load sessions.");
        const { sessions } = await r.json();
        const remote: Row[] = sessions.map((s: { id: string; scenarioTitle: string | null; scenarioId: string; createdAt: string; durationSeconds: number; overallScore: number | null; grade: string | null; graderVersion: string | null; graderMethod: string | null }) => ({ id: s.id, title: s.scenarioTitle ?? s.scenarioId, scenarioId: s.scenarioId, createdAt: s.createdAt, durationSeconds: s.durationSeconds, score: s.overallScore, grade: s.grade, method: (s.graderMethod as Row["method"]) ?? null, legacy: s.overallScore !== null && !s.graderVersion && s.graderMethod !== "llm" }));
        setRows([...remote, ...local].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch((e) => { setError(e.message); setRows(local); });
  }, [capabilities, isLoading, isAuthenticated, router]);

  const counted = useMemo(() => (rows ?? []).filter((r) => showLegacy || !r.legacy), [rows, showLegacy]);
  const stats = useMemo(() => {
    const scored = counted.filter((r) => r.score !== null) as (Row & { score: number })[];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => dayKey(addDays(today, i - 13)));
    const byDay = (pick: (rs: Row[]) => number | null) => days.map((k) => pick(counted.filter((r) => dayKey(new Date(r.createdAt)) === k)));
    const avgOf = (rs: Row[]) => { const s = rs.filter((r) => r.score !== null); return s.length ? s.reduce((a, r) => a + r.score!, 0) / s.length : null; };
    return [
      { label: "Sessions", value: String(rows?.length ?? 0), spark: byDay((rs) => rs.length) },
      { label: "Average score", value: scored.length ? String(Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length)) : "None", spark: byDay(avgOf), max: 100 },
      { label: "Best score", value: scored.length ? String(Math.max(...scored.map((r) => r.score))) : "None", spark: byDay((rs) => Math.max(0, ...rs.map((r) => r.score ?? 0))), max: 100 },
      { label: "Time practised", value: formatDuration(counted.reduce((a, r) => a + r.durationSeconds, 0)), spark: byDay((rs) => rs.reduce((a, r) => a + r.durationSeconds, 0)) },
    ];
  }, [counted, rows]);

  /** Average score per rubric criterion name across browser-stored graded calls. */
  const skills = useMemo(() => {
    const ids = new Set(counted.map((r) => r.id));
    const agg = new Map<string, { sum: number; n: number }>();
    for (const s of listLocalSessions()) {
      if (!ids.has(s.id) || !s.evaluation) continue;
      for (const c of s.evaluation.criteria) { const a = agg.get(c.name) ?? { sum: 0, n: 0 }; a.sum += c.score; a.n++; agg.set(c.name, a); }
    }
    return [...agg.entries()].map(([name, a]) => ({ name, avg: Math.round(a.sum / a.n), n: a.n })).sort((a, b) => a.avg - b.avg);
  }, [counted]);
  const weakest = skills[0];
  const drill = useMemo(() => (weakest ? nextDrill(listScenarios(), { id: rows?.[0]?.scenarioId, role: rows?.[0]?.role }, weakest.name) : undefined), [weakest, rows]);
  const legacyCount = (rows ?? []).filter((r) => r.legacy).length;

  if (!rows) return <PageSkeleton />;

  return (
    <div className="page enter space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Logbook</p>
          <h1 className="mt-1 text-3xl font-bold">Progress{user?.firstName ? `, ${user.firstName}` : ""}</h1>
        </div>
        <Link href="/trainer" className="btn-primary"><Mic size={16} aria-hidden /> New practice call</Link>
      </div>
      {error && <p className="banner-warn">{error}</p>}
      {/* Personas a manager assigned; renders nothing when there are none. */}
      <AssignedToYou />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="panel p-4">
            <p className="label !mb-1">{s.label}</p>
            <p className="mono text-3xl font-semibold">{s.value}</p>
            <div className="mt-2"><Sparkline values={s.spark} max={s.max} /></div>
            <p className="font-mono text-[10px] text-ink-muted">last 14 days</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="panel"><EmptyState icon={PhoneCall} title="No practice calls yet"><p>Run your first scenario and your scores, trends and practice streak show up here.</p><Link href="/library" className="btn-primary btn-pill mt-4"><Mic size={16} aria-hidden /> Pick a persona</Link></EmptyState></div>
      ) : (
        <>
          {/* grid-cols-[minmax(0,1fr)] on phones: an implicit auto column would grow to fit wide charts and widen the page. */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="panel p-4 sm:p-5" aria-labelledby="trend-h">
              <h2 id="trend-h" className="label">Score trend · last 20 graded calls</h2>
              <TrendChart rows={counted} />
            </section>
            <section className="panel flex flex-col p-4 sm:p-5" aria-labelledby="next-h">
              <h2 id="next-h" className="eyebrow">Practise this next</h2>
              {weakest ? (
                <>
                  <p className="mt-2 text-sm">Your weakest area is <strong>{weakest.name}</strong>, averaging <span className="mono">{weakest.avg}</span> over {weakest.n} call{weakest.n === 1 ? "" : "s"}.</p>
                  {drill && (
                    <div className="mt-4 flex items-center gap-3 rounded-lg border border-line p-3">
                      <PersonaAvatar scenario={drill} size={40} />
                      <div className="min-w-0"><p className="truncate text-sm font-semibold">{drill.aiPersona.name}</p><p className="line-clamp-2 text-xs text-ink-muted">{drill.title}</p></div>
                    </div>
                  )}
                  {drill && <div className="mt-auto pt-4"><Link href={`/trainer?scenario=${encodeURIComponent(drill.id)}`} className="btn-primary w-full">Start this drill <ArrowRight size={15} aria-hidden /></Link></div>}
                </>
              ) : <p className="mt-2 text-sm text-ink-muted">Finish a graded call and we&rsquo;ll point you at the skill to drill next.</p>}
            </section>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
            <section className="panel p-4 sm:p-5" aria-labelledby="heat-h">
              <h2 id="heat-h" className="label">Practice days · last 26 weeks</h2>
              <Heatmap rows={rows} />
            </section>
            <section className="panel p-4 sm:p-5" aria-labelledby="skills-h">
              <h2 id="skills-h" className="label">Skills · average by rubric criterion</h2>
              {skills.length ? (
                <ul className="space-y-2.5">
                  {skills.slice(0, 7).map((s) => (
                    <li key={s.name}>
                      <div className="mb-1 flex justify-between gap-2 text-[13px]"><span className="min-w-0 truncate">{s.name}</span><span className="mono text-ink-muted">{s.avg}</span></div>
                      <div className="tape"><span className={s.avg >= 80 ? "bg-ok" : s.avg >= 60 ? "bg-signal" : "bg-caution"} style={{ width: `${s.avg}%` }} /></div>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-ink-muted">Skill averages come from calls graded in this browser.</p>}
            </section>
          </div>
        </>
      )}

      {legacyCount > 0 && (
        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={showLegacy} onChange={(e) => setShowLegacy(e.target.checked)} />
          <span>Include {legacyCount} legacy-grader session{legacyCount === 1 ? "" : "s"} in averages. They were scored with the old keyword grader on a different scale, so they’re excluded by default.</span>
        </label>
      )}

      {rows.length > 0 && (
        <section className="panel overflow-hidden" aria-labelledby="log-h">
          <h2 id="log-h" className="border-b border-line px-4 py-3 text-sm font-bold">Logbook</h2>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-sunken sm:flex-nowrap">
                <Link href={`/trainer/debrief/${r.id}`} className="min-w-0 basis-full rounded sm:basis-auto sm:flex-1">
                  <p className="break-words text-sm font-semibold">{r.title}</p>
                  <p className="font-mono text-[11px] text-ink-muted">{new Date(r.createdAt).toLocaleString()} · {formatDuration(r.durationSeconds)}{r.id.startsWith("local-") ? " · this browser" : ""}</p>
                </Link>
                <div className="flex w-36 items-center gap-2" aria-label={r.score !== null ? `Score ${r.score}, grade ${r.grade}` : "Ungraded"}>
                  {r.score !== null ? (
                    <>
                      <div className="tape flex-1"><span className={r.score >= 80 ? "bg-ok" : r.score >= 60 ? "bg-signal" : "bg-caution"} style={{ width: `${r.score}%` }} /></div>
                      <span className="mono w-12 text-right text-sm">{r.score}<span className="text-ink-muted"> {r.grade}</span></span>
                    </>
                  ) : <span className="text-xs text-ink-muted">Ungraded</span>}
                </div>
                {/* No chip for an ungraded call: the score column already says "Ungraded". */}
                {(r.legacy || r.method) && <span className={`chip !text-[10.5px] ${r.legacy ? "" : r.method === "llm" ? "!border-ok/40 !text-ok" : "!border-caution/40 !text-caution"}`}>{r.legacy ? "Legacy" : r.method === "llm" ? "AI-graded" : "Estimate"}</span>}
                <ChevronRight size={16} className="hidden text-ink-muted sm:block" aria-hidden />
                {r.id.startsWith("local-") && (
                  <button aria-label={`Delete session: ${r.title}, ${new Date(r.createdAt).toLocaleString()}`} title="Delete session"
                    className="ml-auto inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-ink-muted hover:bg-surface hover:text-alert sm:ml-0"
                    onClick={() => removeRow(r)}><Trash2 size={16} aria-hidden /><span className="sm:sr-only">Delete</span></button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {capabilities?.demoMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-dashed border-line p-4 text-sm">
          <p className="text-ink-soft">Demo mode: sessions and custom personas live in this browser only.</p>
          <button className="btn-ghost" onClick={() => setConfirmReset(true)}><RotateCcw size={16} aria-hidden /> Reset demo data</button>
        </div>
      )}

      {confirmReset && <ConfirmDialog title="Reset demo data?" message="This clears all practice sessions and custom personas stored in this browser." confirmLabel="Reset" onConfirm={resetDemo} onCancel={() => setConfirmReset(false)} />}
      {mounted && createPortal(
        <div className="pointer-events-none fixed inset-x-3 z-[100] flex flex-col items-center gap-2" style={{ bottom: "max(5.5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}>
          {notice && <div role="status" className="pointer-events-auto max-w-md rounded-lg bg-ink px-4 py-3 text-sm text-background shadow-pop">{notice}</div>}
          {undo && (
            <div role="status" className="pointer-events-auto flex max-w-md items-center justify-between gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-background shadow-pop">
              <span className="min-w-0 break-words">Deleted “{undo.title}”.</span>
              <button className="shrink-0 rounded-md px-3 py-1.5 font-semibold underline underline-offset-2 hover:opacity-80" onClick={undoDelete}>Undo</button>
            </div>
          )}
        </div>,
        document.body,
      )}
      {(undo || notice) && <div aria-hidden className="h-28" />}
    </div>
  );
}

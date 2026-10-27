"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, ClipboardPlus, Download, FlaskConical, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { PageSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import TeamKpis from "@/components/team/TeamKpis";
import NeedsAttention from "@/components/team/NeedsAttention";
import CriterionHeatmap from "@/components/team/CriterionHeatmap";
import RosterTable from "@/components/team/RosterTable";
import AssignmentsPanel from "@/components/team/AssignmentsPanel";
import AssignSheet from "@/components/team/AssignSheet";
import { localTeamViews } from "@/components/team/localAssignments";
import { useAuth } from "@/contexts/AuthContext";
import { archiveLocalAssignment, ASSIGNMENTS_CHANGED, localNoteIds } from "@/lib/assignmentStore";
import { DEFAULT_WINDOW, memberName, parseWindow, rosterCsv, summarizeAssignments, TEAM_WINDOWS, type AssignmentView, type TeamOverview, type TeamWindow } from "@/lib/team";

type Gate = "loading" | "ready" | "forbidden" | "no_org" | "error";
const WINDOW_KEY = "rtct.team.window";

export default function TeamPage() {
  const { isAuthenticated, isLoading, capabilities, user } = useAuth();
  const router = useRouter();
  // The chosen window is a per-viewer convenience. Nothing reads it during SSR: the page shows a skeleton until data arrives.
  const [days, setDays] = useState<TeamWindow>(() => {
    try { return typeof window === "undefined" ? DEFAULT_WINDOW : parseWindow(localStorage.getItem(WINDOW_KEY)); } catch { return DEFAULT_WINDOW; }
  });
  const [data, setData] = useState<TeamOverview | null>(null);
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);
  const [remote, setRemote] = useState<AssignmentView[] | null>(null);
  const [localTick, setLocalTick] = useState(0);
  const [assignError, setAssignError] = useState("");
  const [sheet, setSheet] = useState<{ assigneeId: string | null } | null>(null);
  const [notice, setNotice] = useState("");
  const local = !!capabilities && (capabilities.demoMode || !capabilities.database);
  const viewer = useMemo(() => (user ? { id: user.id, name: memberName(user) } : null), [user]);

  function pickWindow(d: TeamWindow) {
    setDays(d);
    try { localStorage.setItem(WINDOW_KEY, String(d)); } catch { /* storage blocked */ }
  }

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (!isAuthenticated) { router.replace("/login"); return; }
    let live = true;
    setRefreshing(true);
    fetch(`/api/team/overview?days=${days}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.status === 403) { setGate("forbidden"); return; }
        if (r.status === 404 && body.error === "no_organization") { setGate("no_org"); return; }
        if (!r.ok) throw new Error(body.message || "Could not load your team. Check your connection and try again.");
        const overview = body as TeamOverview;
        // Sample sessions keep their notes in this browser.
        if (overview.sample) {
          const noted = localNoteIds();
          overview.queue = overview.queue.map((q) => (noted.has(q.sessionId) ? { ...q, hasNotes: true } : q));
        }
        setData(overview);
        setError("");
        setGate("ready");
      })
      .catch((e: Error) => { if (live) { setError(e.message); setGate((g) => (g === "ready" ? g : "error")); } })
      .finally(() => { if (live) setRefreshing(false); });
    return () => { live = false; };
  }, [capabilities, isLoading, isAuthenticated, router, days, reload]);

  // Assignments: the API with a database, the browser store in demo mode.
  useEffect(() => {
    if (gate !== "ready" || local) return;
    let live = true;
    fetch("/api/team/assignments?scope=team")
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message || "Could not load assignments. Refresh the page to try again.");
        if (live) { setRemote(body.assignments ?? []); setAssignError(""); }
      })
      .catch((e: Error) => { if (live) { setAssignError(e.message); setRemote((cur) => cur ?? []); } });
    return () => { live = false; };
  }, [gate, local, reload]);

  useEffect(() => {
    if (!local) return;
    const bump = () => setLocalTick((n) => n + 1);
    window.addEventListener(ASSIGNMENTS_CHANGED, bump);
    return () => window.removeEventListener(ASSIGNMENTS_CHANGED, bump);
  }, [local]);

  const assignments = useMemo<AssignmentView[] | null>(() => {
    if (!local) return remote;
    if (!data || !viewer) return null;
    void localTick; // recompute after the store changes
    return localTeamViews(data.members, viewer.id);
  }, [local, remote, data, viewer, localTick]);
  const summary = useMemo(() => summarizeAssignments(assignments ?? [], new Date()), [assignments]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((m) => (m === msg ? "" : m)), 5000);
  }, []);

  async function archive(a: AssignmentView): Promise<boolean> {
    if (local) {
      if (!archiveLocalAssignment(a.id)) { setAssignError("This browser blocked local storage, so the assignment was not archived."); return false; }
      return true;
    }
    const r = await fetch(`/api/team/assignments?id=${encodeURIComponent(a.id)}`, { method: "DELETE" }).catch(() => null);
    if (!r || !r.ok) {
      const body = await r?.json().catch(() => ({}));
      setAssignError(body?.message || "Could not archive the assignment. Check your connection and try again.");
      return false;
    }
    setRemote((cur) => cur && cur.filter((x) => x.id !== a.id));
    setAssignError("");
    return true;
  }

  function exportCsv() {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([rosterCsv(data.roster, data.days)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `team-roster-${data.days}-days.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function setNoted(sessionId: string, has: boolean) {
    setData((d) => d && { ...d, queue: d.queue.map((q) => (q.sessionId === sessionId ? { ...q, hasNotes: has } : q)) });
  }

  if (gate === "forbidden") {
    return (
      <div className="page enter">
        <div className="panel mx-auto max-w-lg">
          <EmptyState icon={ShieldCheck} title="Team view is for managers">
            <p>Managers and owners use this page to coach their reps. Your own scores, trends and assignments are on your Progress page.</p>
            <Link href="/dashboard" className="btn-primary btn-pill mt-4">Go to Progress</Link>
          </EmptyState>
        </div>
      </div>
    );
  }
  if (gate === "no_org") {
    return (
      <div className="page enter">
        <div className="panel mx-auto max-w-lg">
          <EmptyState icon={Building2} title="You're not on a team yet">
            <p>Your account is not part of an organization. Register with your team&rsquo;s org code, or ask the org owner to add you.</p>
            <Link href="/dashboard" className="btn-ghost btn-pill mt-4">Go to Progress</Link>
          </EmptyState>
        </div>
      </div>
    );
  }
  if (gate === "error" || (gate === "ready" && !data)) {
    return (
      <div className="page enter">
        <div className="panel mx-auto max-w-lg">
          <EmptyState icon={RefreshCw} title="Team data did not load">
            <p>{error || "Something went wrong loading your team."}</p>
            <button type="button" className="btn-primary btn-pill mt-4" onClick={() => { setGate("loading"); setReload((n) => n + 1); }}>Try again</button>
          </EmptyState>
        </div>
      </div>
    );
  }
  if (!data || !viewer) return <PageSkeleton rows={4} />;

  return (
    <div className="page enter space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Team view</p>
          <h1 className="mt-1 break-words text-3xl font-bold">{data.org.name}</h1>
          <p className="mt-1 text-sm text-ink-muted">{data.kpis.totalReps} people on the roster · updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Time window" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
            {TEAM_WINDOWS.map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => pickWindow(d)}
                className={`min-h-[34px] rounded-md px-3 font-mono text-xs font-medium transition-colors ${days === d ? "bg-primary text-primary-on" : "text-ink-soft hover:bg-sunken hover:text-ink"}`}>
                {d} days
              </button>
            ))}
          </div>
          {refreshing && <Loader2 size={16} strokeWidth={1.75} className="animate-spin text-ink-muted" aria-label="Updating" />}
          <button type="button" className="btn-ghost" onClick={exportCsv}><Download size={16} strokeWidth={1.75} aria-hidden /> Export CSV</button>
          <button type="button" className="btn-primary" onClick={() => setSheet({ assigneeId: null })}><ClipboardPlus size={16} strokeWidth={1.75} aria-hidden /> Assign persona</button>
        </div>
      </div>

      {data.sample && (
        <div className="banner-warn flex items-start gap-3">
          <FlaskConical size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-caution" aria-hidden />
          <p><strong>Sample data.</strong> This is a made-up team so you can explore the view in demo mode. Assignments and notes you add are saved in this browser only. Connect a database and invite reps with your org code to see your real team.</p>
        </div>
      )}
      {error && <p className="banner-warn" role="alert">{error} Showing the last data that loaded.</p>}
      <div role="status" aria-live="polite">
        {notice && <p className="rounded-lg border border-ok/40 bg-ok-soft px-3 py-2 text-sm text-ink">{notice}</p>}
      </div>

      <TeamKpis kpis={data.kpis} days={data.days} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <NeedsAttention items={data.queue} sample={data.sample} days={data.days} authorName={viewer.name} onNotes={setNoted} />
        <AssignmentsPanel items={assignments} summary={summary} error={assignError} onAssign={() => setSheet({ assigneeId: null })} onArchive={archive} />
      </div>

      <section className="panel p-4 sm:p-5" aria-labelledby="matrix-h">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="matrix-h" className="text-sm font-bold">Skills by rep</h2>
          <p className="font-mono text-[11px] text-ink-muted">average score per rubric criterion · last {data.days} days</p>
        </div>
        <CriterionHeatmap matrix={data.matrix} days={data.days} />
      </section>

      <section className="panel overflow-hidden" aria-labelledby="roster-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          <h2 id="roster-h" className="text-sm font-bold">Roster</h2>
          <p className="font-mono text-[11px] text-ink-muted">{data.kpis.activeReps} of {data.kpis.totalReps} practised in the last {data.days} days</p>
        </div>
        <RosterTable rows={data.roster} days={data.days} viewerId={viewer.id} onAssign={(id) => setSheet({ assigneeId: id })} />
      </section>

      {sheet && (
        <AssignSheet members={data.members} viewer={viewer} defaultAssigneeId={sheet.assigneeId} local={local}
          onClose={() => setSheet(null)}
          onCreated={(a) => {
            setSheet(null);
            if (!local && "progress" in a) setRemote((cur) => [a, ...(cur ?? [])]);
            flash(`Assigned ${a.scenarioTitle}.`);
          }} />
      )}
    </div>
  );
}

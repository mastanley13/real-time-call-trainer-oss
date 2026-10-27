"use client";

import { useRef, useState } from "react";
import { AlarmClock, Archive, CalendarClock, Check, ClipboardList, ClipboardPlus } from "lucide-react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { dueLabel, isComplete, isOverdue, relativeDay, type AssignmentSummary, type AssignmentView } from "@/lib/team";

function Progress({ a, now }: { a: AssignmentView; now: Date }) {
  const p = a.progress;
  if (a.assigneeId) {
    return isComplete(p)
      ? <span className="chip !border-ok/40 !text-ok"><Check size={12} strokeWidth={1.75} aria-hidden />Done {p.lastDoneAt ? relativeDay(p.lastDoneAt, now) : ""}</span>
      : <span className="chip">Not started</span>;
  }
  if (!p.total) return <span className="text-xs text-ink-muted">No reps on the team yet</span>;
  const pct = Math.round((p.done / p.total) * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="tape w-20" aria-hidden><span className={isComplete(p) ? "bg-ok" : "bg-primary"} style={{ width: `${Math.max(3, pct)}%` }} /></span>
      <span className="mono text-xs text-ink-soft">{p.done} of {p.total} done</span>
    </span>
  );
}

/** Active training assignments with derived completion and an archive action. */
export default function AssignmentsPanel({ items, summary, error, onAssign, onArchive }: {
  items: AssignmentView[] | null;
  summary: AssignmentSummary;
  error: string;
  onAssign: () => void;
  onArchive: (a: AssignmentView) => Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState<AssignmentView | null>(null);
  const [status, setStatus] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const archiveRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const now = new Date();

  async function archive() {
    const a = confirm;
    setConfirm(null);
    if (!a) return;
    // The row goes away with the archive button ConfirmDialog returns focus to, so pick where focus lands next.
    const list = items ?? [];
    const at = list.findIndex((x) => x.id === a.id);
    const next = list[at + 1] ?? list[at - 1];
    const ok = await onArchive(a);
    setStatus(ok ? `Archived ${a.scenarioTitle}.` : "");
    if (ok) requestAnimationFrame(() => ((next && archiveRefs.current[next.id]) || headingRef.current)?.focus());
  }

  return (
    <section className="panel flex flex-col overflow-hidden" aria-labelledby="assign-h">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <h2 id="assign-h" ref={headingRef} tabIndex={-1} className="text-sm font-bold outline-none">Assignments</h2>
          <p className="font-mono text-[11px] text-ink-muted">
            {summary.active} active · {summary.completed} done{summary.overdue ? ` · ${summary.overdue} overdue` : ""}
          </p>
        </div>
        <button type="button" className="btn-primary btn-sm" onClick={onAssign}><ClipboardPlus size={14} strokeWidth={1.75} aria-hidden /> Assign persona</button>
      </div>
      {error && <p className="banner-warn m-4" role="alert">{error}</p>}
      <span role="status" className="sr-only">{status}</span>
      {items === null ? (
        <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-start gap-3 px-4 py-6 sm:px-5">
          <ClipboardList size={20} strokeWidth={1.75} className="text-ink-muted" aria-hidden />
          <div>
            <p className="text-sm font-semibold">No assignments yet</p>
            <p className="mt-0.5 text-sm text-ink-soft">Assign a persona to one rep or the whole team. It shows up on their Progress page, and it counts as done once they practise it.</p>
          </div>
        </div>
      ) : (
        <ul className="scroll-thin max-h-[560px] divide-y divide-line overflow-y-auto">
          {items.map((a) => {
            const late = isOverdue(a, now);
            const who = a.assigneeName ?? "Whole team";
            return (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold">{a.scenarioTitle}</p>
                  <p className="text-xs text-ink-muted">{who}{a.assignedByName ? ` · from ${a.assignedByName}` : ""}</p>
                  {a.note && <p className="mt-1 line-clamp-2 break-words text-xs text-ink-soft">{a.note}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {a.dueAt && (
                      <span className={`chip ${late ? "!border-caution/50 !text-caution" : ""}`}>
                        {late ? <AlarmClock size={12} strokeWidth={1.75} aria-hidden /> : <CalendarClock size={12} strokeWidth={1.75} aria-hidden />}
                        {isComplete(a.progress) ? `Was due ${new Date(a.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : dueLabel(a.dueAt, now)}
                      </span>
                    )}
                    <Progress a={a} now={now} />
                  </div>
                </div>
                <button ref={(el) => { archiveRefs.current[a.id] = el; }} type="button" className="btn-quiet !min-h-[36px] !px-2" title="Archive" onClick={() => setConfirm(a)}>
                  <Archive size={16} strokeWidth={1.75} aria-hidden /><span className="sr-only">Archive {a.scenarioTitle} for {who}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog title="Archive this assignment?" confirmLabel="Archive"
          message={`${confirm.scenarioTitle} drops off the list for ${confirm.assigneeName ?? "the whole team"}. Practice sessions already done are kept.`}
          onConfirm={archive} onCancel={() => setConfirm(null)} />
      )}
    </section>
  );
}

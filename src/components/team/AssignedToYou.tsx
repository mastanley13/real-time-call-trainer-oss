"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlarmClock, ArrowRight, CalendarClock, Check } from "lucide-react";
import { PersonaAvatar } from "@/components/ui/Persona";
import { localViewsFor } from "@/components/team/localAssignments";
import { useAuth } from "@/contexts/AuthContext";
import { ASSIGNMENTS_CHANGED } from "@/lib/assignmentStore";
import { getScenario } from "@/lib/scenarioStore";
import { dueLabel, isComplete, isOverdue, memberName, relativeDay, sortForAssignee, type AssignmentView } from "@/lib/team";

const SHOW = 5;

/**
 * "Assigned to you" on the Progress page. Reads the API when there is a
 * database and the browser store in demo mode. Renders nothing until there is
 * at least one assignment, so reps without a manager never see an empty box.
 */
export default function AssignedToYou() {
  const { user, capabilities, isAuthenticated } = useAuth();
  const [items, setItems] = useState<AssignmentView[] | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!capabilities || !isAuthenticated || !user) return;
    if (capabilities.demoMode || !capabilities.database) {
      const load = () => setItems(localViewsFor({ id: user.id, name: memberName(user) }));
      load();
      window.addEventListener(ASSIGNMENTS_CHANGED, load);
      return () => window.removeEventListener(ASSIGNMENTS_CHANGED, load);
    }
    let live = true;
    fetch("/api/team/assignments?scope=mine")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load your assignments. Refresh the page to try again.");
        const body = await r.json();
        if (live) setItems(sortForAssignee(body.assignments ?? []));
      })
      .catch((e: Error) => { if (live) { setError(e.message); setItems([]); } });
    return () => { live = false; };
  }, [capabilities, isAuthenticated, user]);

  if (error) return <p className="banner-warn">{error}</p>;
  if (!items?.length || !user) return null;

  const now = new Date();
  const open = items.filter((a) => !isComplete(a.progress)).length;
  const shown = all ? items : items.slice(0, SHOW);
  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="assigned-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="assigned-h" className="eyebrow">Assigned to you</h2>
        <p className="font-mono text-[11px] text-ink-muted">{open} open · {items.length - open} done</p>
      </div>
      <ul className="mt-2 divide-y divide-line">
        {shown.map((a) => {
          const done = isComplete(a.progress);
          const late = isOverdue(a, now);
          const s = getScenario(a.scenarioId);
          const from = a.assignedById !== user.id && a.assignedByName ? `from ${a.assignedByName}` : a.assigneeId ? "" : "for the whole team";
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:flex-nowrap">
              <PersonaAvatar scenario={s ?? { id: a.scenarioId, aiPersona: { name: a.scenarioTitle, role: "", behavior: "", openingLine: "" } }} size={38} />
              <div className="min-w-0 flex-1 basis-[60%]">
                <p className="break-words text-sm font-semibold">{a.scenarioTitle}</p>
                <p className="text-xs text-ink-muted">{[s?.aiPersona.name, from].filter(Boolean).join(" · ")}</p>
                {a.note && <p className="mt-1 line-clamp-2 break-words text-xs text-ink-soft">{a.note}</p>}
              </div>
              {a.dueAt && !done && (
                <span className={`chip shrink-0 ${late ? "!border-caution/50 !text-caution" : ""}`}>
                  {late ? <AlarmClock size={12} strokeWidth={1.75} aria-hidden /> : <CalendarClock size={12} strokeWidth={1.75} aria-hidden />}{dueLabel(a.dueAt, now)}
                </span>
              )}
              {done ? (
                <span className="chip shrink-0 !border-ok/40 !text-ok"><Check size={12} strokeWidth={1.75} aria-hidden />Done {a.progress.lastDoneAt ? relativeDay(a.progress.lastDoneAt, now) : ""}</span>
              ) : !s ? (
                <span className="shrink-0 text-xs text-ink-muted">This persona is not in your library. Ask your manager to reassign it.</span>
              ) : (
                <Link href={`/trainer?scenario=${encodeURIComponent(a.scenarioId)}`} className="btn-primary btn-sm shrink-0">
                  Pre-flight <ArrowRight size={13} strokeWidth={1.75} aria-hidden /><span className="sr-only">: {a.scenarioTitle}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > SHOW && (
        <button type="button" className="btn-quiet btn-sm mt-1" aria-expanded={all} onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>
      )}
    </section>
  );
}

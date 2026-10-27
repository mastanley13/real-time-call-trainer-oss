"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ClipboardPlus, Users } from "lucide-react";
import ScoreSparkline from "@/components/team/ScoreSparkline";
import { ROLE_LABEL, relativeDay, scoreBand, type RosterRow } from "@/lib/team";

type SortKey = "name" | "sessions" | "avg" | "last";
const TAPE = { ok: "bg-ok", signal: "bg-signal", caution: "bg-caution", none: "bg-line" } as const;
const COLS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: "name", label: "Rep" },
  { key: "sessions", label: "Sessions", className: "text-right" },
  { key: "avg", label: "Average" },
  { key: "last", label: "Last session" },
  { key: null, label: "Recent scores" },
  { key: null, label: "Weakest criterion" },
  { key: null, label: "Actions", className: "w-px" },
];

function value(r: RosterRow, key: SortKey): string | number {
  if (key === "name") return r.name.toLowerCase();
  if (key === "sessions") return r.sessions;
  if (key === "avg") return r.avgScore ?? -1;
  return r.lastSessionAt ? Date.parse(r.lastSessionAt) : 0;
}

/** Roster with sortable columns. Scrolls inside its own container on phones. */
export default function RosterTable({ rows, days, viewerId, onAssign }: { rows: RosterRow[]; days: number; viewerId?: string; onAssign: (repId: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const sorted = useMemo(() => {
    const out = [...rows].sort((a, b) => {
      const x = value(a, sort.key), y = value(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sort.dir;
    });
    return out;
  }, [rows, sort]);
  const now = new Date();

  if (!rows.length) {
    return (
      <div className="flex items-start gap-3 px-4 py-6 sm:px-5">
        <Users size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
        <p className="text-sm text-ink-soft">No reps yet. Share your org code so your team can register, and they show up here.</p>
      </div>
    );
  }

  return (
    // relative: the sr-only labels are absolutely positioned; without a containing block inside the
    // scroller they escape it and widen the whole page on phones.
    <div className="scroll-thin relative overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <caption className="sr-only">Team roster for the last {days} days. Column headers with buttons sort the table.</caption>
        <thead className="border-b border-line">
          <tr>
            {COLS.map((c) => {
              const active = c.key !== null && sort.key === c.key;
              return (
                <th key={c.label} scope="col" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  className={`whitespace-nowrap px-3 py-2.5 text-left font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted first:pl-4 last:pr-4 sm:first:pl-5 ${c.className ?? ""}`}>
                  {c.key ? (
                    <button type="button" className={`inline-flex items-center gap-1 rounded uppercase hover:text-ink ${active ? "text-ink" : ""}`}
                      onClick={() => setSort((s) => ({ key: c.key!, dir: s.key === c.key ? ((-s.dir) as 1 | -1) : c.key === "name" ? 1 : -1 }))}>
                      {c.label}
                      {active && (sort.dir === 1 ? <ArrowUp size={12} strokeWidth={1.75} aria-hidden /> : <ArrowDown size={12} strokeWidth={1.75} aria-hidden />)}
                    </button>
                  ) : c.label === "Actions" ? <span className="sr-only">{c.label}</span> : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sorted.map((r) => {
            const band = scoreBand(r.avgScore);
            return (
              <tr key={r.id} className="transition-colors hover:bg-sunken/60">
                <th scope="row" className="py-3 pl-4 pr-3 text-left font-normal sm:pl-5">
                  <span className="block font-semibold">{r.name}{r.id === viewerId ? <span className="font-normal text-ink-muted"> (you)</span> : null}</span>
                  {r.role !== "trainee" && <span className="font-mono text-[10.5px] text-ink-muted">{ROLE_LABEL[r.role]}</span>}
                </th>
                <td className="mono px-3 py-3 text-right">{r.sessions}</td>
                <td className="px-3 py-3">
                  {r.avgScore === null ? <span className="text-xs text-ink-muted">No graded calls</span> : (
                    <span className="flex items-center gap-2">
                      <span className="tape w-16" aria-hidden><span className={TAPE[band]} style={{ width: `${r.avgScore}%` }} /></span>
                      <span className="mono font-semibold">{r.avgScore}</span>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  {r.lastSessionAt ? (
                    <>
                      <span className="block">{relativeDay(r.lastSessionAt, now)}</span>
                      <span className="font-mono text-[11px] text-ink-muted">{r.lastScore === null ? "ungraded" : `scored ${r.lastScore}`}</span>
                    </>
                  ) : <span className="text-xs text-ink-muted">Never practised</span>}
                </td>
                <td className="px-3 py-3"><ScoreSparkline values={r.spark} /></td>
                <td className="max-w-[220px] px-3 py-3">
                  {r.weakest ? (
                    <>
                      <span className="block truncate" title={r.weakest}>{r.weakest}</span>
                      <span className="font-mono text-[11px] text-ink-muted">averages {r.weakestScore}</span>
                    </>
                  ) : <span className="text-xs text-ink-muted">No data in {days} days</span>}
                </td>
                <td className="py-3 pl-3 pr-4 text-right sm:pr-5">
                  <button type="button" className="btn-ghost btn-sm" onClick={() => onAssign(r.id)}>
                    <ClipboardPlus size={14} strokeWidth={1.75} aria-hidden /> Assign<span className="sr-only"> a persona to {r.name}</span>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

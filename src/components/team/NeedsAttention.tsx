"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, CheckCircle2, MessageSquareText, Repeat2, Target, TrendingDown, type LucideIcon } from "lucide-react";
import NoteEditor from "@/components/team/NoteEditor";
import { relativeDay, type QueueItem, type QueueReasonKind } from "@/lib/team";

const REASON: Record<QueueReasonKind, { icon: LucideIcon; tone: string }> = {
  low_score: { icon: TrendingDown, tone: "!border-alert/40 !text-alert" },
  goal_missed: { icon: Target, tone: "!border-caution/50 !text-caution" },
  repeat_weakness: { icon: Repeat2, tone: "!border-primary/40 !text-primary" },
};
const PREVIEW = 6;

function QueueRow({ item, sample, authorName, now, onNotes }: { item: QueueItem; sample: boolean; authorName: string; now: Date; onNotes: (has: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const noteBtn = useRef<HTMLButtonElement>(null);
  const severe = item.score !== null && item.score < 60;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        <span className={`lamp mt-1.5 ${severe ? "lamp-alert" : "lamp-caution"}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm"><span className="font-semibold">{item.repName}</span> <span className="text-ink-muted">on</span> <span className="break-words">{item.scenarioTitle}</span></p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{relativeDay(item.createdAt, now)}{item.hasNotes ? " · noted" : ""}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Why it is flagged">
            {item.reasons.map((r) => {
              const { icon: Icon, tone } = REASON[r.kind];
              return <li key={r.kind} className={`chip bg-surface ${tone}`}><Icon size={12} strokeWidth={1.75} aria-hidden />{r.label}</li>;
            })}
          </ul>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {sample ? (
              <span className="text-xs text-ink-muted">Sample session, so there is no debrief to open.</span>
            ) : (
              <Link href={`/trainer/debrief/${encodeURIComponent(item.sessionId)}`} className="btn-ghost btn-sm">Open debrief <ArrowRight size={13} strokeWidth={1.75} aria-hidden /></Link>
            )}
            <button ref={noteBtn} type="button" className="btn-quiet btn-sm" aria-expanded={editing} onClick={() => { setStatus(""); setEditing((v) => !v); }}>
              <MessageSquareText size={13} strokeWidth={1.75} aria-hidden /> {item.hasNotes ? "Edit note" : "Add note"}
              <span className="sr-only"> for {item.repName} on {item.scenarioTitle}</span>
            </button>
            <span role="status" className="text-xs text-ok">{status}</span>
          </div>
          {editing && (
            <NoteEditor sessionId={item.sessionId} repName={item.repName} sample={sample} hasNotes={item.hasNotes} authorName={authorName}
              onClose={(saved) => {
                setEditing(false);
                noteBtn.current?.focus();
                if (saved !== null) { onNotes(saved); setStatus(saved ? "Note saved." : "Note removed."); }
              }} />
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="mono text-xl font-semibold">{item.score ?? "None"}</p>
          <p className="font-mono text-[10px] text-ink-muted">{item.score === null ? "ungraded" : "score"}</p>
        </div>
      </div>
    </li>
  );
}

/** Coaching queue: low scores, missed goals and repeated weak spots in the window, unnoted ones first. */
export default function NeedsAttention({ items, sample, days, authorName, onNotes }: {
  items: QueueItem[];
  sample: boolean;
  days: number;
  authorName: string;
  onNotes: (sessionId: string, has: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const now = new Date();
  const open = items.filter((i) => !i.hasNotes).length;
  const shown = all ? items : items.slice(0, PREVIEW);
  return (
    <section className="panel overflow-hidden" aria-labelledby="queue-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <h2 id="queue-h" className="text-sm font-bold">Needs attention</h2>
        <p className="font-mono text-[11px] text-ink-muted">{items.length ? `${open} without a note · ${items.length} flagged` : `last ${days} days`}</p>
      </div>
      {items.length === 0 ? (
        <div className="flex items-start gap-3 px-4 py-6 sm:px-5">
          <CheckCircle2 size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />
          <div>
            <p className="text-sm font-semibold">Nothing needs attention</p>
            <p className="mt-0.5 text-sm text-ink-soft">No calls in the last {days} days scored under 60, missed the goal, or repeated the same weak spot three times.</p>
          </div>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {shown.map((item) => (
              <QueueRow key={item.sessionId} item={item} sample={sample} authorName={authorName} now={now} onNotes={(has) => onNotes(item.sessionId, has)} />
            ))}
          </ul>
          {items.length > PREVIEW && (
            <div className="border-t border-line px-4 py-2.5 sm:px-5">
              <button type="button" className="btn-quiet btn-sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${items.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

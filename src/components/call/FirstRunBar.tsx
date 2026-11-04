import Link from "next/link";
import { Mic, RotateCcw } from "lucide-react";
import { FIRST_RUN_REPLIES } from "@/lib/firstRun";

export const FIRST_RUN_COPY = "reply 3 times, then we grade it. No mic needed.";
export const FIRST_GRADED_COPY = "That's your first graded call. Try it out loud next: voice uses your free minutes.";

/** One line above the score on the debrief of a first-run call, with the two next steps. No upsell. */
export function FirstGradedNote({ scenarioId }: { scenarioId?: string }) {
  const base = scenarioId ? `/trainer?scenario=${encodeURIComponent(scenarioId)}&` : "/trainer?";
  return (
    <div className="panel flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center print:hidden">
      <p className="flex min-w-0 flex-1 items-start gap-2.5 text-sm">
        <span className="lamp lamp-ok mt-1.5" aria-hidden />
        <span>{FIRST_GRADED_COPY}</span>
      </p>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Link href={`${base}mode=text`} className="btn-ghost btn-sm"><RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Practice again (text)</Link>
        <Link href={`${base}mode=voice`} className="btn-primary btn-sm"><Mic size={14} strokeWidth={1.75} aria-hidden /> Try voice</Link>
      </div>
    </div>
  );
}

/** The first-run target above the text composer: what to do, how far along, and the way out to a voice call. */
export default function FirstRunBar({ replies, onSwitchToVoice }: { replies: number; onSwitchToVoice?: () => void }) {
  const n = Math.min(replies, FIRST_RUN_REPLIES);
  return (
    // Phones keep this to the copy plus the counter on the right, so the composer stays in view above the keyboard.
    <div className="mb-3 flex items-start gap-3 rounded-panel border border-line bg-sunken px-3 py-2 sm:items-center">
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink-soft">
        <span className="font-semibold text-ink">Practice call 1 of 1:</span> {FIRST_RUN_COPY}
        {onSwitchToVoice && (
          <>
            {" "}
            <button type="button" className="-my-1 inline-flex items-center gap-1 whitespace-nowrap py-1 font-semibold text-primary underline-offset-2 hover:underline" onClick={onSwitchToVoice}>
              <Mic size={13} strokeWidth={1.75} aria-hidden />Switch to voice
            </button>
          </>
        )}
      </p>
      <p className="flex shrink-0 items-center gap-2 pt-0.5 sm:pt-0" aria-live="polite" aria-atomic="true">
        <span className="flex gap-1" aria-hidden>
          {Array.from({ length: FIRST_RUN_REPLIES }, (_, i) => (
            <span key={i} className={`h-1.5 w-4 rounded-full motion-safe:transition-colors ${i < n ? "bg-primary" : "bg-ink-muted/50"}`} />
          ))}
        </span>
        <span className="sr-only">Replies sent: {n} of {FIRST_RUN_REPLIES}</span>
        <span className="mono text-xs font-semibold tabular-nums" aria-hidden>{n}/{FIRST_RUN_REPLIES}</span>
      </p>
    </div>
  );
}

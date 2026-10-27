"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { getLocalNote, setLocalNote } from "@/lib/assignmentStore";

const MAX = 4000;
/** Stands in for notes that sample sessions already "have" until the viewer writes their own. */
const SAMPLE_NOTE = "Covered this in our one-to-one. Run the objection drill twice before Friday and send me the debrief.";

/**
 * Inline supervisor-note editor. Real sessions use the existing notes route
 * (GET to load, PUT { note } to save, an empty note clears it); sample sessions
 * keep notes in this browser.
 */
export default function NoteEditor({ sessionId, repName, sample, hasNotes, authorName, onClose }: {
  sessionId: string;
  repName: string;
  sample: boolean;
  hasNotes: boolean;
  authorName: string;
  /** Called with the new has-notes state after a save, or null on cancel. */
  onClose: (saved: boolean | null) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(!sample);
  // Saving stays off until the stored note has loaded, so a failed or skipped
  // GET can never turn into a PUT that replaces a note nobody saw.
  const [loadFailed, setLoadFailed] = useState<"retry" | "denied" | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** supervisorNotesAt as loaded, sent back so the route can refuse a stale overwrite. */
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const id = `note-${sessionId}`;

  useEffect(() => {
    if (sample) {
      setText(getLocalNote(sessionId)?.note ?? (hasNotes ? SAMPLE_NOTE : ""));
      ref.current?.focus();
      return;
    }
    // Always load, whatever hasNotes says: the queue can be stale if another manager added a note since.
    let live = true;
    let denied = false;
    let failed = false;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes`)
      .then(async (r) => {
        denied = r.status === 403;
        if (!r.ok) throw new Error(String(r.status));
        const body = await r.json();
        if (live) { setText(body.supervisorNotes ?? ""); setLoadedAt(body.supervisorNotesAt ?? null); }
      })
      .catch(() => {
        if (!live) return;
        failed = true;
        setLoadFailed(denied ? "denied" : "retry");
        setError(denied
          ? "You can't read notes on this session, so you can't edit them either."
          : "Could not load the current note. Saving is off so you don't overwrite it. Check your connection and try again.");
      })
      .finally(() => {
        if (!live) return;
        setLoading(false);
        requestAnimationFrame(() => (failed ? retryRef.current : ref.current)?.focus());
      });
    return () => { live = false; };
  }, [sessionId, sample, hasNotes, attempt]);

  function retry() {
    setError("");
    setLoadFailed(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  const blocked = loading || saving || loadFailed !== null;

  async function save() {
    if (blocked) return;
    setSaving(true);
    setError("");
    const has = text.trim().length > 0;
    try {
      if (sample) {
        if (!setLocalNote(sessionId, text, authorName)) throw new Error("This browser blocked local storage, so the note was not saved.");
      } else {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text, expectedNotesAt: loadedAt }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(
            r.status === 429 ? "You're saving notes quickly. Wait a minute and try again."
            : r.status === 409 ? "Someone changed this note after you opened it. Copy your text, then cancel and open the note again to see their version."
            : body.message || body.error || "Could not save the note. Check your connection and try again.",
          );
        }
      }
      onClose(has);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-sunken/60 p-3">
      <label htmlFor={id} className="label">Supervisor note for {repName}</label>
      <textarea id={id} ref={ref} className="input min-h-[84px] resize-y bg-surface" maxLength={MAX} value={text} disabled={blocked}
        placeholder={loading ? "Loading the current note..." : loadFailed ? "The current note did not load." : "What should they work on next? Be specific."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(null); } if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">{sample ? "Sample notes stay in this browser." : "Your rep sees this on their debrief. Save it empty to remove it."}</p>
        <div className="flex items-center gap-2">
          <span className="mono text-[10px] text-ink-muted" aria-hidden>{text.length}/{MAX}</span>
          <button type="button" className="btn-quiet btn-sm" onClick={() => onClose(null)} disabled={saving}>Cancel</button>
          {loadFailed === "retry" ? (
            <button ref={retryRef} type="button" className="btn-ghost btn-sm" onClick={retry}>
              <RotateCw size={14} strokeWidth={1.75} aria-hidden /> Retry
            </button>
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={save} disabled={blocked}>
              {saving && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />} Save note
            </button>
          )}
        </div>
      </div>
      {error && <p role="alert" className="field-msg">{error}</p>}
    </div>
  );
}

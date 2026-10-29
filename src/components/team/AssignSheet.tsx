"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Info, Loader2, Search } from "lucide-react";
import Sheet from "@/components/ui/Sheet";
import { PersonaAvatar } from "@/components/ui/Persona";
import { listScenarios } from "@/lib/scenarioStore";
import { jobFamilyLabel, type Scenario } from "@/lib/scenarios";
import { createLocalAssignment } from "@/lib/assignmentStore";
import { NOTE_MAX, ROLE_LABEL, teamIdsOf, type Assignment, type AssignmentView, type TeamMember } from "@/lib/team";

const SHOW = 60;
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function matches(s: Scenario, q: string): boolean {
  const hay = `${s.title} ${s.aiPersona.name} ${s.aiPersona.role} ${s.industry} ${jobFamilyLabel(s.role)}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

/**
 * "Assign persona" sheet: pick a persona (search plus job-family filter), a rep
 * or the whole team, an optional due date and note. Saves through the API, or
 * to this browser in demo mode.
 */
export default function AssignSheet({ members, viewer, defaultAssigneeId, local, onClose, onCreated }: {
  members: TeamMember[];
  viewer: { id: string; name: string };
  defaultAssigneeId: string | null;
  /** Demo mode or no database: save to this browser. */
  local: boolean;
  onClose: () => void;
  onCreated: (a: Assignment | AssignmentView) => void;
}) {
  const [scenarios] = useState(() => listScenarios());
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [picked, setPicked] = useState<Scenario | null>(null);
  const [assignee, setAssignee] = useState(defaultAssigneeId ?? "");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitRef = useRef<HTMLButtonElement>(null);

  const families = useMemo(() => [...new Set(scenarios.map((s) => s.role))].sort((a, b) => jobFamilyLabel(a).localeCompare(jobFamilyLabel(b))), [scenarios]);
  const results = useMemo(() => scenarios.filter((s) => (!family || s.role === family) && matches(s, query)), [scenarios, family, query]);
  const teamSize = teamIdsOf(members).length;
  const reps = members.filter((m) => m.role === "trainee");
  const leads = members.filter((m) => m.role !== "trainee");
  const today = new Date();
  const label = (m: TeamMember) => `${m.name}${m.id === viewer.id ? " (you)" : ""}`;

  async function submit() {
    if (saving) return;
    if (!picked) { setError("Pick a persona to assign."); return; }
    setSaving(true);
    setError("");
    // A calendar date means "by the end of that day" in the manager's time zone.
    const input = {
      assigneeId: assignee || null, scenarioId: picked.id, scenarioTitle: picked.title,
      note: note.trim() || null, dueAt: due ? new Date(`${due}T23:59:59`).toISOString() : null,
    };
    try {
      if (local) {
        const r = createLocalAssignment(input, viewer.id);
        if (!r.ok) throw new Error(r.message);
        onCreated(r.assignment);
        return;
      }
      const res = await fetch("/api/team/assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || "Could not save the assignment. Check your connection and try again.");
      onCreated(body.assignment as AssignmentView);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
      // Keep focus inside the sheet, on the action to try again.
      submitRef.current?.focus();
    }
  }

  return (
    <Sheet title="Assign persona" subtitle="It shows up on their Progress page with a Pre-flight link." onClose={onClose} wide
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 flex-1 text-sm" role={error ? "alert" : undefined}>
            {error ? <span className="font-medium text-alert">{error}</span> : picked ? <span className="text-ink-soft">Assigning <strong className="text-ink">{picked.aiPersona.name}</strong></span> : <span className="text-ink-muted">Pick a persona to continue.</span>}
          </p>
          <div className="flex gap-2">
            {/* aria-disabled while saving: a disabled button that has focus drops it to the page, outside this dialog. */}
            <button type="button" className="btn-ghost" onClick={() => { if (!saving) onClose(); }} aria-disabled={saving}>Cancel</button>
            <button ref={submitRef} type="button" className="btn-primary" onClick={submit} disabled={!saving && !picked} aria-disabled={saving}>
              {saving && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />} Assign persona
            </button>
          </div>
        </div>
      }>
      <div className="space-y-6">
        <fieldset>
          <legend className="label">Persona</legend>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px]">
            <div className="relative">
              <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
              <input data-autofocus type="search" className="input pl-9" placeholder="Search by name, title or industry" aria-label="Search personas" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <select className="input" aria-label="Job family" value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">All job families</option>
              {families.map((f) => <option key={f} value={f}>{jobFamilyLabel(f)}</option>)}
            </select>
          </div>
          <p className="mt-2 font-mono text-[11px] text-ink-muted" aria-live="polite">
            {results.length > SHOW ? `Showing ${SHOW} of ${results.length}. Narrow the search to see the rest.` : `${results.length} persona${results.length === 1 ? "" : "s"}`}
          </p>
          <div className="scroll-thin mt-2 max-h-[300px] space-y-1.5 overflow-y-auto rounded-lg border border-line p-1.5" role="radiogroup" aria-label="Personas">
            {results.length === 0 && <p className="px-2 py-6 text-center text-sm text-ink-muted">No personas match. Try a shorter search or another job family.</p>}
            {results.slice(0, SHOW).map((s) => {
              const on = picked?.id === s.id;
              // Custom personas live in the manager's browser, so reps on other devices could not open them.
              const blocked = !local && !s.builtIn;
              return (
                <label key={s.id} className={`flex items-center gap-3 rounded-md border p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${on ? "border-primary bg-primary-soft/50" : "border-transparent hover:bg-sunken"} ${blocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input type="radio" name="assign-persona" className="sr-only" checked={on} disabled={blocked} onChange={() => { setPicked(s); setError(""); }} />
                  {/* Only the persona itself is dimmed; the reason stays at full contrast, since it is the only place a manager learns why. */}
                  <span className={blocked ? "opacity-60" : ""}><PersonaAvatar scenario={s} size={36} /></span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-semibold ${blocked ? "opacity-60" : ""}`}>{s.aiPersona.name}</span>
                    <span className={`block truncate text-xs text-ink-muted ${blocked ? "opacity-60" : ""}`}>{s.title}</span>
                    {blocked && <span className="mt-0.5 flex items-start gap-1 text-[11px] text-ink-soft"><Info size={12} strokeWidth={1.75} className="mt-px shrink-0 text-caution" aria-hidden />Custom persona in this browser only, so your reps can&rsquo;t open it.</span>}
                  </span>
                  <span className="hidden shrink-0 font-mono text-[10px] text-ink-muted sm:inline">{jobFamilyLabel(s.role)}</span>
                  {on && <Check size={16} strokeWidth={1.75} className="shrink-0 text-primary" aria-hidden />}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="assign-to" className="label">Assign to</label>
            <select id="assign-to" className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Whole team ({teamSize} rep{teamSize === 1 ? "" : "s"})</option>
              {reps.length > 0 && <optgroup label="Reps">{reps.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}</optgroup>}
              {leads.length > 0 && <optgroup label="Managers and owners">{leads.map((m) => <option key={m.id} value={m.id}>{label(m)} · {ROLE_LABEL[m.role]}</option>)}</optgroup>}
            </select>
          </div>
          <div>
            <label htmlFor="assign-due" className="label">Due date <span className="normal-case tracking-normal">(optional)</span></label>
            <input id="assign-due" type="date" className="input" value={due} min={isoDay(today)} max={isoDay(new Date(today.getTime() + 365 * 86_400_000))} onChange={(e) => setDue(e.target.value)} />
          </div>
        </div>

        <div>
          <label htmlFor="assign-note" className="label">Note <span className="normal-case tracking-normal">(optional)</span></label>
          <textarea id="assign-note" className="input min-h-[88px] resize-y" maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="What to focus on, for example: hold your price and ask one more discovery question first." />
          <p className="mt-1 text-right font-mono text-[10px] text-ink-muted">{note.length}/{NOTE_MAX}</p>
        </div>
      </div>
    </Sheet>
  );
}

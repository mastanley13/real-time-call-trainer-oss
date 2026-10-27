"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { Copy, Plus, Trash2, Save, Play } from "lucide-react";
import { CALL_TYPES, CALL_TYPE_LABELS, JOB_FAMILIES, OBJECTION_LABELS, OBJECTION_TYPES, Scenario, ScenarioSchema, newBlankScenario } from "@/lib/scenarios";
import { ZodIssue } from "zod";
import { deleteCustomScenario, duplicateScenario, listScenarios, saveCustomScenario } from "@/lib/scenarioStore";

const DRAFT_KEY = "rtct.editor.draft.v1";

/** Field key -> element id, in on-screen order (used to focus the first invalid field). */
const FIELD_IDS: [string, string][] = [
  ["title", "t"], ["industry", "i"], ["aiPersona.name", "pn"], ["aiPersona.role", "pr"], ["aiPersona.behavior", "pb"],
  ["aiPersona.openingLine", "po"], ["aiPersona.voiceId", "pv"], ["traineeGoal", "g"], ["callScript", "s"],
];
const LABELS: Record<string, string> = {
  title: "Title", industry: "Industry", "aiPersona.name": "Caller name", "aiPersona.role": "Caller role", "aiPersona.behavior": "Behavior",
  "aiPersona.openingLine": "Opening line", "aiPersona.voiceId": "Voice ID", traineeGoal: "Trainee goal", callScript: "Call script", sampleReplies: "Scripted replies",
};

function friendlyIssue(i: ZodIssue, key: string): string {
  const m = key.match(/^rubric\.(\d+)\.(\w+)$/);
  const label = m ? `${{ name: "Name", weight: "Weight", description: "Description" }[m[2]] ?? "Field"}` : (LABELS[key] ?? "This field");
  if (i.code === "too_small") return key === "rubric" ? "Add at least one criterion." : `${label} is required.`;
  if (i.code === "too_big") {
    const max = (i as { maximum?: number | bigint }).maximum;
    return m?.[2] === "weight" ? "Weight must be between 0 and 100." : `${label} is too long (max ${max} characters).`;
  }
  if (m?.[2] === "weight") return "Weight must be a number between 0 and 100.";
  return `${label} is not valid.`;
}

export default function ScenarioEditor() {
  const [all, setAll] = useState<Scenario[]>([]);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  function duplicate() {
    if (!draft) return;
    const c = duplicateScenario(draft);
    refresh(c.id);
    setToast("Scenario duplicated");
    // Wait for the new draft to render, then bring the editor into view and focus the title.
    setTimeout(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      const title = document.getElementById("t") as HTMLInputElement | null;
      title?.focus({ preventScroll: true });
    }, 50);
  }

  const clearErrors = (prefix?: string) => {
    setFormError("");
    setErrors((e) => (prefix ? Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(prefix))) : {}));
  };

  const refresh = (selectId?: string) => {
    const list = listScenarios();
    setAll(list);
    if (selectId) setDraft(structuredClone(list.find((s) => s.id === selectId) ?? list[0]));
  };

  useEffect(() => {
    const list = listScenarios();
    setAll(list);
    // Restore unsaved work from before a reload; only after hydration do we start writing it back.
    let restored: Scenario | null = null;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      const p = raw ? ScenarioSchema.safeParse(JSON.parse(raw)) : null;
      if (p?.success) restored = p.data;
    } catch {
      /* ignore corrupt draft */
    }
    // ?id=<scenario> (from the library's "Duplicate & edit") wins over a restored draft.
    const wanted = new URLSearchParams(window.location.search).get("id");
    const fromUrl = wanted ? list.find((s) => s.id === wanted) : undefined;
    setDraft(fromUrl ? structuredClone(fromUrl) : restored ?? structuredClone(list.find((s) => !s.builtIn) ?? list[0]));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !draft) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* storage full/unavailable */
    }
  }, [hydrated, draft]);

  if (!draft) return null;
  const readOnly = !!draft.builtIn;
  const patch = (p: Partial<Scenario>) => {
    setDraft({ ...draft, ...p });
    setSaved(false);
    // Editing a field clears its own stale error (rubric edits clear all rubric rows: indexes may shift).
    setFormError("");
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !Object.keys(p).some((f) => (f === "rubric" ? k.startsWith("rubric") : k === f || k.startsWith(`${f}.`))))));
  };
  const patchPersona = (p: Partial<Scenario["aiPersona"]>) => patch({ aiPersona: { ...draft.aiPersona, ...p } });
  // Heading shows the saved name until the draft is saved, so clearing the field mid-edit doesn't flip it to "Untitled".
  const savedTitle = all.find((s) => s.id === draft.id)?.title || draft.title.trim() || "New scenario";
  const total = Math.round(draft.rubric.reduce((a, c) => a + (Number(c.weight) || 0), 0));
  const err = (k: string) => errors[k];
  const bad = (k: string) => ({ "aria-invalid": err(k) ? (true as const) : undefined, "aria-describedby": err(k) ? `err-${k}` : undefined });
  const msg = (k: string) => err(k) && <p id={`err-${k}`} className="field-msg">{err(k)}</p>;

  function save() {
    const candidate = {
      ...draft!,
      sampleReplies: draft!.sampleReplies.filter((l) => l.trim()),
      rubric: draft!.rubric.map((c, i) => ({ ...c, id: c.id || `c${i + 1}`, weight: Number(c.weight) || 0 })),
    };
    const parsed = ScenarioSchema.safeParse(candidate);
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const key = i.path.length >= 2 && i.path[0] === "rubric" ? i.path.slice(0, 3).join(".") : i.path.slice(0, i.path[0] === "aiPersona" ? 2 : 1).join(".");
        found[key] ??= friendlyIssue(i, key);
      }
      setErrors(found);
      const n = Object.keys(found).length;
      setFormError(`Couldn’t save: ${n === 1 ? "1 field needs" : `${n} fields need`} attention. ${n === 1 ? "It is" : "They are"} highlighted below.`);
      const order = [...FIELD_IDS, ...draft!.rubric.flatMap((_, i) => [[`rubric.${i}.name`, `rn-${i}`], [`rubric.${i}.weight`, `rw-${i}`], [`rubric.${i}.description`, `rd-${i}`]] as [string, string][])];
      const first = order.find(([k]) => found[k]);
      requestAnimationFrame(() => (first ? document.getElementById(first[1]) : null)?.focus());
      return;
    }
    clearErrors();
    saveCustomScenario(parsed.data);
    setSaved(true);
    refresh(parsed.data.id);
  }

  const field = "input";
  return (
    <div className="page enter grid gap-6 lg:grid-cols-[280px_1fr]">
      <aside className="card h-fit lg:sticky lg:top-20">
        <button className="btn-primary mb-3 w-full" onClick={() => { const b = newBlankScenario(); setDraft(b); setSaved(false); clearErrors(); }}>
          <Plus size={16} /> New scenario
        </button>
        <p className="label mt-1">Your personas</p>
        <ul className="space-y-1">
          {all.filter((s) => !s.builtIn || s.id === draft.id).map((s) => (
            <li key={s.id}>
              <button onClick={() => { setDraft(structuredClone(s)); clearErrors(); setSaved(false); }}
                className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${draft.id === s.id ? "bg-primary-soft font-semibold text-ink" : "hover:bg-sunken"}`}>
                {s.title}
                <span className="block text-xs font-normal text-ink-muted">{s.builtIn ? "Library · read-only" : "Mine"}</span>
              </button>
            </li>
          ))}
          {!all.some((s) => !s.builtIn) && <li className="px-1 text-xs text-ink-muted">Duplicate a library persona or start a new one.</li>}
        </ul>
        <Link href="/library" className="btn-ghost btn-sm mt-3 w-full">Browse the library</Link>
      </aside>

      <div ref={editorRef} className="card scroll-mt-20 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">{readOnly ? "Built-in scenario" : "Edit scenario"}: {savedTitle}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href={`/trainer?scenario=${encodeURIComponent(draft.id)}`} className="btn-ghost"><Play size={16} /> Practice</Link>
            {all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost" onClick={duplicate}><Copy size={16} /> Duplicate</button>
            )}
            {!readOnly && all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost text-alert" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete</button>
            )}
            {!readOnly && <button className="btn-primary" onClick={save}><Save size={16} /> Save</button>}
          </div>
        </div>
        {readOnly && <p className="banner-warn">Library personas can’t be edited. Duplicate one to customise it.</p>}
        {formError && <p role="alert" className="rounded-lg border border-alert/40 bg-alert-soft p-3 text-sm font-medium">{formError}</p>}
        {saved && <p role="status" className="rounded-lg bg-ok-soft p-3 text-sm">Saved to this browser.</p>}

        <fieldset disabled={readOnly} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label" htmlFor="t">Title</label><input id="t" className={field} {...bad("title")} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />{msg("title")}</div>
            <div><label className="label" htmlFor="d">Difficulty</label>
              <select id="d" className={field} value={draft.difficulty} onChange={(e) => patch({ difficulty: e.target.value as Scenario["difficulty"] })}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="sm:col-span-2"><label className="label" htmlFor="i">Industry</label><input id="i" className={field} {...bad("industry")} value={draft.industry} onChange={(e) => patch({ industry: e.target.value })} />{msg("industry")}</div>
            <div><label className="label" htmlFor="role">Sales job</label>
              <select id="role" className={field} value={draft.role} onChange={(e) => patch({ role: e.target.value })}>
                {JOB_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select></div>
            <div><label className="label" htmlFor="ct">Call type</label>
              <select id="ct" className={field} value={draft.callType} onChange={(e) => patch({ callType: e.target.value as Scenario["callType"] })}>
                {CALL_TYPES.map((c) => <option key={c} value={c}>{CALL_TYPE_LABELS[c]}</option>)}
              </select></div>
          </div>

          <div className="rounded-panel border border-line bg-sunken/50 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-semibold">AI persona</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="pn">Name</label><input id="pn" className={field} {...bad("aiPersona.name")} value={draft.aiPersona.name} onChange={(e) => patchPersona({ name: e.target.value })} />{msg("aiPersona.name")}</div>
              <div><label className="label" htmlFor="pr">Role</label><input id="pr" className={field} {...bad("aiPersona.role")} value={draft.aiPersona.role} onChange={(e) => patchPersona({ role: e.target.value })} />{msg("aiPersona.role")}</div>
            </div>
            <div className="mt-4"><label className="label" htmlFor="pb">Behavior</label><textarea id="pb" rows={4} className={field} {...bad("aiPersona.behavior")} value={draft.aiPersona.behavior} onChange={(e) => patchPersona({ behavior: e.target.value })} />{msg("aiPersona.behavior")}</div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="po">Opening line</label><input id="po" className={field} {...bad("aiPersona.openingLine")} value={draft.aiPersona.openingLine} onChange={(e) => patchPersona({ openingLine: e.target.value })} />{msg("aiPersona.openingLine")}</div>
              <div><label className="label" htmlFor="pv">ElevenLabs voice ID (optional)</label><input id="pv" className={field} {...bad("aiPersona.voiceId")} value={draft.aiPersona.voiceId ?? ""} onChange={(e) => patchPersona({ voiceId: e.target.value || undefined })} />{msg("aiPersona.voiceId")}</div>
            </div>
          </div>

          <div><label className="label" htmlFor="g">Trainee goal</label><textarea id="g" rows={2} className={field} {...bad("traineeGoal")} value={draft.traineeGoal} onChange={(e) => patch({ traineeGoal: e.target.value })} />{msg("traineeGoal")}</div>
          <div><label className="label" htmlFor="s">Call script / talk track</label><textarea id="s" rows={6} className={field} {...bad("callScript")} value={draft.callScript} onChange={(e) => patch({ callScript: e.target.value })} />{msg("callScript")}</div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Rubric <span className={`ml-2 text-xs font-normal ${total === 100 ? "text-ink-muted" : "font-semibold text-caution"}`}>Weights total {total}%.{total === 100 ? "" : " Weights should add up to 100%. Scores are rescaled when graded."}</span></h2>
              {!readOnly && <button type="button" className="btn-ghost !min-h-[36px]" onClick={() => patch({ rubric: [...draft.rubric, { id: `c${Date.now().toString(36)}`, name: "", description: "", weight: 10 }] })}><Plus size={14} /> Criterion</button>}
            </div>
            <div className="space-y-3">
              {draft.rubric.map((c, i) => (
                <div key={c.id + i} className={`grid items-end gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_100px_auto] ${Object.keys(errors).some((k) => k.startsWith(`rubric.${i}.`)) ? "border-alert bg-alert-soft/40" : "border-line"}`}>
                  <div>
                  <input id={`rn-${i}`} aria-label={`Criterion ${i + 1} name`} placeholder="Name" className={field} {...bad(`rubric.${i}.name`)} value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                  {msg(`rubric.${i}.name`)}
                  </div>
                  <div>
                  <label htmlFor={`rw-${i}`} className="label !mb-1 whitespace-nowrap">Weight (%)</label>
                  <input id={`rw-${i}`} aria-label={`Criterion ${i + 1} weight`} type="number" min={0} max={100} className={field} {...bad(`rubric.${i}.weight`)} value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                  {msg(`rubric.${i}.weight`)}
                  </div>
                  {!readOnly && <button type="button" aria-label={`Remove criterion ${i + 1}`} className="btn-ghost self-end text-alert" disabled={draft.rubric.length <= 1} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={16} aria-hidden /> Remove</button>}
                  <div className="sm:col-span-3"><textarea id={`rd-${i}`} aria-label={`Criterion ${i + 1} description`} placeholder="What good looks like" rows={2} className={field} {...bad(`rubric.${i}.description`)} value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />{msg(`rubric.${i}.description`)}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Objections <span className="ml-1 text-xs font-normal text-ink-muted">The live coach uses these to cue you with the prep answer</span></h2>
              {!readOnly && <button type="button" className="btn-ghost !min-h-[36px]" disabled={draft.objections.length >= 8} onClick={() => patch({ objections: [...draft.objections, { type: "price", line: "", prepAnswer: "" }] })}><Plus size={14} /> Objection</button>}
            </div>
            <div className="space-y-3">
              {draft.objections.map((o, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[160px_1fr_auto]">
                  <select aria-label={`Objection ${i + 1} type`} className={field} value={o.type} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, type: e.target.value as Scenario["objections"][number]["type"] } : x)) })}>
                    {OBJECTION_TYPES.map((t) => <option key={t} value={t}>{OBJECTION_LABELS[t]}</option>)}
                  </select>
                  <input aria-label={`Objection ${i + 1} line`} placeholder="What the caller says" className={field} value={o.line} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)) })} />
                  {!readOnly && <button type="button" aria-label={`Remove objection ${i + 1}`} className="btn-ghost text-alert" onClick={() => patch({ objections: draft.objections.filter((_, j) => j !== i) })}><Trash2 size={16} aria-hidden /></button>}
                  <input aria-label={`Objection ${i + 1} prep answer`} placeholder="Prep answer the coach can suggest" className={`${field} sm:col-span-3`} value={o.prepAnswer} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, prepAnswer: e.target.value } : x)) })} />
                </div>
              ))}
              {draft.objections.length === 0 && <p className="text-xs text-ink-muted">No objections yet. Add the pushback this caller should raise.</p>}
            </div>
          </div>

          <div><label className="label" htmlFor="sr">Scripted caller replies for offline text simulation (one per line)</label>
            <textarea id="sr" rows={4} className={field} {...bad("sampleReplies")} value={draft.sampleReplies.join("\n")} onChange={(e) => patch({ sampleReplies: e.target.value.split("\n") })} />{msg("sampleReplies")}</div>
        </fieldset>
      </div>
      {confirmDelete && draft && (
        <ConfirmDialog title="Delete this scenario?" message={`“${savedTitle}” will be removed from this browser.`} confirmLabel="Delete"
          onConfirm={() => { setConfirmDelete(false); deleteCustomScenario(draft.id); clearErrors(); refresh(listScenarios()[0].id); }}
          onCancel={() => setConfirmDelete(false)} />
      )}
      {toast && createPortal(
        <div className="pointer-events-none fixed inset-x-3 z-[100] flex justify-center" style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <div role="status" className="max-w-md rounded-lg bg-ink px-4 py-3 text-sm text-background shadow-pop">{toast}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Copy, Plus, Trash2, Save, Play } from "lucide-react";
import { Scenario, ScenarioSchema, newBlankScenario } from "@/lib/scenarios";
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
    setDraft(restored ?? structuredClone(list[0]));
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
        <ul className="space-y-1">
          {all.map((s) => (
            <li key={s.id}>
              <button onClick={() => { setDraft(structuredClone(s)); clearErrors(); setSaved(false); }}
                className={`w-full rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${draft.id === s.id ? "bg-primary-soft font-semibold text-primary" : "hover:bg-slate-50"}`}>
                {s.title}
                <span className="block text-xs font-normal text-ink-muted">{s.builtIn ? "Built-in · read-only" : "Custom"}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="card space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold sm:text-2xl">{readOnly ? "Built-in scenario" : "Edit scenario"}: {draft.title || "Untitled"}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href={`/trainer?scenario=${encodeURIComponent(draft.id)}`} className="btn-ghost"><Play size={16} /> Practice</Link>
            {all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost" onClick={() => { const c = duplicateScenario(draft); refresh(c.id); }}><Copy size={16} /> Duplicate</button>
            )}
            {!readOnly && all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost text-red-600" onClick={() => { if (confirm("Delete this scenario?")) { deleteCustomScenario(draft.id); clearErrors(); refresh(listScenarios()[0].id); } }}><Trash2 size={16} /> Delete</button>
            )}
            {!readOnly && <button className="btn-primary" onClick={save}><Save size={16} /> Save</button>}
          </div>
        </div>
        {readOnly && <p className="banner-warn">Built-in scenarios can’t be edited. Duplicate one to customise it.</p>}
        {formError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">{formError}</p>}
        {saved && <p role="status" className="rounded-xl bg-accent-soft p-3 text-sm">Saved to this browser.</p>}

        <fieldset disabled={readOnly} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label" htmlFor="t">Title</label><input id="t" className={field} {...bad("title")} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />{msg("title")}</div>
            <div><label className="label" htmlFor="d">Difficulty</label>
              <select id="d" className={field} value={draft.difficulty} onChange={(e) => patch({ difficulty: e.target.value as Scenario["difficulty"] })}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select></div>
          </div>
          <div><label className="label" htmlFor="i">Industry</label><input id="i" className={field} {...bad("industry")} value={draft.industry} onChange={(e) => patch({ industry: e.target.value })} />{msg("industry")}</div>

          <div className="rounded-2xl border border-line bg-slate-50/50 p-4 sm:p-5">
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
              <h2 className="text-sm font-semibold">Rubric <span className={`ml-2 text-xs font-normal ${total === 100 ? "text-ink-muted" : "font-semibold text-amber-800"}`}>Weights total {total}%{total === 100 ? "" : " — should add up to 100% (scores are rescaled when graded)"}</span></h2>
              {!readOnly && <button type="button" className="btn-ghost !min-h-[36px]" onClick={() => patch({ rubric: [...draft.rubric, { id: `c${Date.now().toString(36)}`, name: "", description: "", weight: 10 }] })}><Plus size={14} /> Criterion</button>}
            </div>
            <div className="space-y-3">
              {draft.rubric.map((c, i) => (
                <div key={c.id + i} className={`grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_90px_auto] ${Object.keys(errors).some((k) => k.startsWith(`rubric.${i}.`)) ? "border-red-600 bg-red-50/50" : "border-line"}`}>
                  <div>
                  <input id={`rn-${i}`} aria-label={`Criterion ${i + 1} name`} placeholder="Name" className={field} {...bad(`rubric.${i}.name`)} value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                  {msg(`rubric.${i}.name`)}
                  </div>
                  <div>
                  <input id={`rw-${i}`} aria-label={`Criterion ${i + 1} weight`} type="number" min={0} max={100} className={field} {...bad(`rubric.${i}.weight`)} value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                  {msg(`rubric.${i}.weight`)}
                  </div>
                  {!readOnly && <button type="button" aria-label={`Remove criterion ${i + 1}`} className="btn-ghost text-red-600" disabled={draft.rubric.length <= 1} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>}
                  <div className="sm:col-span-3"><textarea id={`rd-${i}`} aria-label={`Criterion ${i + 1} description`} placeholder="What good looks like" rows={2} className={field} {...bad(`rubric.${i}.description`)} value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />{msg(`rubric.${i}.description`)}</div>
                </div>
              ))}
            </div>
          </div>

          <div><label className="label" htmlFor="sr">Scripted caller replies for offline text simulation (one per line)</label>
            <textarea id="sr" rows={4} className={field} {...bad("sampleReplies")} value={draft.sampleReplies.join("\n")} onChange={(e) => patch({ sampleReplies: e.target.value.split("\n") })} />{msg("sampleReplies")}</div>
        </fieldset>
      </div>
    </div>
  );
}

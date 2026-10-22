"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Copy, Plus, Trash2, Save, Play } from "lucide-react";
import { Scenario, ScenarioSchema, newBlankScenario } from "@/lib/scenarios";
import { deleteCustomScenario, duplicateScenario, listScenarios, saveCustomScenario } from "@/lib/scenarioStore";

export default function ScenarioEditor() {
  const [all, setAll] = useState<Scenario[]>([]);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const refresh = (selectId?: string) => {
    const list = listScenarios();
    setAll(list);
    if (selectId) setDraft(structuredClone(list.find((s) => s.id === selectId) ?? list[0]));
  };

  useEffect(() => {
    const list = listScenarios();
    setAll(list);
    setDraft(structuredClone(list[0]));
  }, []);

  if (!draft) return null;
  const readOnly = !!draft.builtIn;
  const patch = (p: Partial<Scenario>) => { setDraft({ ...draft, ...p }); setSaved(false); };
  const patchPersona = (p: Partial<Scenario["aiPersona"]>) => patch({ aiPersona: { ...draft.aiPersona, ...p } });
  const total = draft.rubric.reduce((a, c) => a + (Number(c.weight) || 0), 0);

  function save() {
    const candidate = {
      ...draft!,
      sampleReplies: draft!.sampleReplies.filter((l) => l.trim()),
      rubric: draft!.rubric.map((c, i) => ({ ...c, id: c.id || `c${i + 1}`, weight: Number(c.weight) || 0 })),
    };
    const parsed = ScenarioSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setError("");
    saveCustomScenario(parsed.data);
    setSaved(true);
    refresh(parsed.data.id);
  }

  const field = "input";
  return (
    <div className="page grid gap-6 lg:grid-cols-[280px_1fr]">
      <aside className="card h-fit">
        <button className="btn-primary mb-3 w-full" onClick={() => { const b = newBlankScenario(); setDraft(b); setSaved(false); setError(""); }}>
          <Plus size={16} /> New scenario
        </button>
        <ul className="space-y-1">
          {all.map((s) => (
            <li key={s.id}>
              <button onClick={() => { setDraft(structuredClone(s)); setError(""); setSaved(false); }}
                className={`w-full rounded-xl px-3 py-2 text-left text-sm ${draft.id === s.id ? "bg-primary-soft font-semibold text-primary" : "hover:bg-slate-50"}`}>
                {s.title}
                <span className="block text-xs font-normal text-ink-muted">{s.builtIn ? "Built-in · read-only" : "Custom"}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="card space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold">{readOnly ? "Built-in scenario" : "Edit scenario"}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href={`/trainer?scenario=${encodeURIComponent(draft.id)}`} className="btn-ghost"><Play size={16} /> Practice</Link>
            {all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost" onClick={() => { const c = duplicateScenario(draft); refresh(c.id); }}><Copy size={16} /> Duplicate</button>
            )}
            {!readOnly && all.some((s) => s.id === draft.id) && (
              <button className="btn-ghost text-red-600" onClick={() => { if (confirm("Delete this scenario?")) { deleteCustomScenario(draft.id); refresh(listScenarios()[0].id); } }}><Trash2 size={16} /> Delete</button>
            )}
            {!readOnly && <button className="btn-primary" onClick={save}><Save size={16} /> Save</button>}
          </div>
        </div>
        {readOnly && <p className="banner-warn">Built-in scenarios can’t be edited. Duplicate one to customise it.</p>}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {saved && <p role="status" className="rounded-xl bg-accent-soft p-3 text-sm">Saved to this browser.</p>}

        <fieldset disabled={readOnly} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label" htmlFor="t">Title</label><input id="t" className={field} value={draft.title} onChange={(e) => patch({ title: e.target.value })} /></div>
            <div><label className="label" htmlFor="d">Difficulty</label>
              <select id="d" className={field} value={draft.difficulty} onChange={(e) => patch({ difficulty: e.target.value as Scenario["difficulty"] })}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select></div>
          </div>
          <div><label className="label" htmlFor="i">Industry</label><input id="i" className={field} value={draft.industry} onChange={(e) => patch({ industry: e.target.value })} /></div>

          <div className="rounded-xl border border-line p-4">
            <h2 className="mb-3 text-sm font-semibold">AI persona</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="pn">Name</label><input id="pn" className={field} value={draft.aiPersona.name} onChange={(e) => patchPersona({ name: e.target.value })} /></div>
              <div><label className="label" htmlFor="pr">Role</label><input id="pr" className={field} value={draft.aiPersona.role} onChange={(e) => patchPersona({ role: e.target.value })} /></div>
            </div>
            <div className="mt-4"><label className="label" htmlFor="pb">Behavior</label><textarea id="pb" rows={4} className={field} value={draft.aiPersona.behavior} onChange={(e) => patchPersona({ behavior: e.target.value })} /></div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="po">Opening line</label><input id="po" className={field} value={draft.aiPersona.openingLine} onChange={(e) => patchPersona({ openingLine: e.target.value })} /></div>
              <div><label className="label" htmlFor="pv">ElevenLabs voice ID (optional)</label><input id="pv" className={field} value={draft.aiPersona.voiceId ?? ""} onChange={(e) => patchPersona({ voiceId: e.target.value || undefined })} /></div>
            </div>
          </div>

          <div><label className="label" htmlFor="g">Trainee goal</label><textarea id="g" rows={2} className={field} value={draft.traineeGoal} onChange={(e) => patch({ traineeGoal: e.target.value })} /></div>
          <div><label className="label" htmlFor="s">Call script / talk track</label><textarea id="s" rows={6} className={field} value={draft.callScript} onChange={(e) => patch({ callScript: e.target.value })} /></div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Rubric <span className={`ml-2 text-xs font-normal ${Math.round(total) === 100 ? "text-ink-muted" : "text-amber-700"}`}>weights total {total} (normalised when graded)</span></h2>
              {!readOnly && <button type="button" className="btn-ghost !min-h-[36px]" onClick={() => patch({ rubric: [...draft.rubric, { id: `c${Date.now().toString(36)}`, name: "", description: "", weight: 10 }] })}><Plus size={14} /> Criterion</button>}
            </div>
            <div className="space-y-3">
              {draft.rubric.map((c, i) => (
                <div key={c.id + i} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_90px_auto]">
                  <input aria-label="Criterion name" placeholder="Name" className={field} value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                  <input aria-label="Weight" type="number" min={0} max={100} className={field} value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                  {!readOnly && <button type="button" aria-label="Remove criterion" className="btn-ghost text-red-600" disabled={draft.rubric.length <= 1} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>}
                  <textarea aria-label="Criterion description" placeholder="What good looks like" rows={2} className={`${field} sm:col-span-3`} value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />
                </div>
              ))}
            </div>
          </div>

          <div><label className="label" htmlFor="sr">Scripted caller replies for offline text simulation (one per line)</label>
            <textarea id="sr" rows={4} className={field} value={draft.sampleReplies.join("\n")} onChange={(e) => patch({ sampleReplies: e.target.value.split("\n") })} /></div>
        </fieldset>
      </div>
    </div>
  );
}

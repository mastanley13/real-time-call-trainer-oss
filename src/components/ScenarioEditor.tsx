"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { Check, Copy, Loader2, Lock, Plus, Trash2, Save, Play, Users } from "lucide-react";
import { PersonaAvatar } from "@/components/ui/Persona";
import { FormSkeleton } from "@/components/ui/Skeleton";
import { CALL_TYPES, CALL_TYPE_LABELS, JOB_FAMILIES, OBJECTION_LABELS, OBJECTION_TYPES, Scenario, ScenarioSchema, newBlankScenario } from "@/lib/scenarios";
import { ZodIssue } from "zod";
import { duplicateScenario, fetchScenarios, listScenarios, persistCustomScenario, removeCustomScenario, type ScenarioMeta } from "@/lib/scenarioStore";
import { useAuth } from "@/contexts/AuthContext";

const DRAFT_KEY = "rtct.editor.draft.v1";

/** Field key -> element id, in on-screen order (used to focus the first invalid field). */
const FIELD_IDS: [string, string][] = [
  ["title", "t"], ["industry", "i"], ["aiPersona.name", "pn"], ["aiPersona.role", "pr"], ["aiPersona.behavior", "pb"],
  ["aiPersona.openingLine", "po"], ["aiPersona.voiceId", "pv"], ["traineeGoal", "g"], ["callScript", "s"],
];
const LABELS: Record<string, string> = {
  title: "Scenario title", industry: "Industry", "aiPersona.name": "Name", "aiPersona.role": "Who they are", "aiPersona.behavior": "Behavior",
  "aiPersona.openingLine": "Opening line", "aiPersona.voiceId": "Voice ID", traineeGoal: "Rep goal", callScript: "Talk track", sampleReplies: "Scripted replies",
};

/** Categorical criterion hue (--cat-1 to --cat-8), in the same order the Library, the Wizard and the Debrief use. */
const critHue = (i: number) => `rgb(var(--cat-${(i % 8) + 1}))`;

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
  const { user, capabilities, isAuthenticated } = useAuth();
  const [all, setAll] = useState<Scenario[]>([]);
  const [meta, setMeta] = useState<Record<string, ScenarioMeta>>({});
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [sharedWithOrg, setSharedWithOrg] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);

  const stored = !!capabilities?.database && !capabilities?.demoMode;
  const canShareWithOrg = stored && (user?.role === "manager" || user?.role === "owner" || !!user?.isPlatformAdmin);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function duplicate() {
    if (!draft) return;
    const c = duplicateScenario(draft);
    if (stored) {
      try {
        await persistCustomScenario({ scenario: c, useDatabase: true });
      } catch {
        /* localStorage copy already saved */
      }
    }
    await refresh(c.id);
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

  const refresh = async (selectId?: string) => {
    const res = await fetchScenarios(stored && isAuthenticated);
    setAll(res.scenarios);
    setMeta(res.meta);
    if (selectId) {
      const picked = res.scenarios.find((s) => s.id === selectId) ?? res.scenarios[0];
      setDraft(structuredClone(picked));
      setSharedWithOrg(!!res.meta[picked.id]?.sharedWithOrg);
    }
  };

  useEffect(() => {
    let alive = true;
    const wanted = new URLSearchParams(window.location.search).get("id");
    let restored: Scenario | null = null;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      const p = raw ? ScenarioSchema.safeParse(JSON.parse(raw)) : null;
      if (p?.success) restored = p.data;
    } catch {
      /* ignore corrupt draft */
    }
    const apply = (list: Scenario[], nextMeta: Record<string, ScenarioMeta>) => {
      if (!alive) return;
      setAll(list);
      setMeta(nextMeta);
      const fromUrl = wanted ? list.find((s) => s.id === wanted) : undefined;
      const picked = fromUrl ? structuredClone(fromUrl) : restored ?? structuredClone(list.find((s) => !s.builtIn) ?? list[0]);
      setDraft(picked);
      setSharedWithOrg(!!nextMeta[picked.id]?.sharedWithOrg);
      setHydrated(true);
    };
    const localList = listScenarios();
    apply(localList, {});
    if (stored && isAuthenticated) {
      fetchScenarios(true).then((res) => apply(res.scenarios, res.meta));
    }
    return () => { alive = false; };
  }, [stored, isAuthenticated]);

  useEffect(() => {
    if (!hydrated || !draft) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* storage full/unavailable */
    }
  }, [hydrated, draft]);

  if (!draft) return <FormSkeleton />;
  const currentMeta = meta[draft.id];
  const readOnly = !!draft.builtIn || (currentMeta?.stored === "database" && currentMeta.canEdit === false);
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

  async function save() {
    if (saving) return;
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
    setSaving(true);
    try {
      const existingMeta = meta[parsed.data.id];
      const isDbUpdate = stored && existingMeta?.stored === "database";
      const result = await persistCustomScenario({
        scenario: parsed.data,
        useDatabase: stored && isAuthenticated,
        sharedWithOrg: canShareWithOrg ? sharedWithOrg : undefined,
        expectedUpdatedAt: isDbUpdate ? existingMeta.updatedAt : undefined,
        isUpdate: isDbUpdate,
      });
      setSaved(true);
      await refresh(result.scenario.id);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not save this persona. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const field = "input";
  const persisted = all.some((s) => s.id === draft.id);
  const list = all.filter((s) => !s.builtIn || s.id === draft.id);
  return (
    <div className="page enter grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
      <aside className="card h-fit !p-4 lg:sticky lg:top-[calc(var(--header-h,3.5rem)+1rem)]" aria-label="Scenarios">
        <button className="btn-primary mb-4 w-full" onClick={() => { const b = newBlankScenario(); setDraft(b); setSaved(false); clearErrors(); }}>
          <Plus size={16} strokeWidth={1.75} aria-hidden /> New scenario
        </button>
        <p className="label">Your personas</p>
        <ul className="space-y-1">
          {list.map((s) => {
            const current = draft.id === s.id;
            return (
              <li key={s.id}>
                <button onClick={() => { setDraft(structuredClone(s)); setSharedWithOrg(!!meta[s.id]?.sharedWithOrg); clearErrors(); setSaved(false); }} aria-current={current ? "true" : undefined}
                  className={`flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${current ? "bg-primary-soft/60 font-semibold text-ink ring-1 ring-primary/30" : "hover:bg-sunken"}`}>
                  <PersonaAvatar scenario={s} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{s.title || "Untitled scenario"}</span>
                    <span className="block font-mono text-[11px] font-normal text-ink-muted">{s.builtIn ? "Library · read-only" : meta[s.id]?.sharedWithOrg ? "Team · shared" : "Mine"}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {!all.some((s) => !s.builtIn) && <li className="px-1 py-1 text-xs text-ink-muted">Duplicate a library persona or start a new one.</li>}
        </ul>
        <Link href="/library" className="btn-ghost btn-sm mt-4 w-full">Browse the library</Link>
      </aside>

      <div ref={editorRef} className="card min-w-0 scroll-mt-[calc(var(--header-h,3.5rem)+1rem)] space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <PersonaAvatar scenario={draft} size={44} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold sm:text-2xl">{savedTitle}</h1>
              <p className="mt-0.5 font-mono text-[12px] text-ink-muted">
                {draft.builtIn ? "Library · read-only" : readOnly ? "Team · read-only" : persisted ? (currentMeta?.stored === "database" ? (currentMeta.sharedWithOrg ? "Team · saved on account" : "Mine · saved on account") : "Mine · saved in this browser") : "Mine · not saved yet"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/trainer?scenario=${encodeURIComponent(draft.id)}`} className="btn-ghost"><Play size={16} strokeWidth={1.75} aria-hidden /> Practice</Link>
            {persisted && !readOnly && (
              <button className="btn-ghost" onClick={() => void duplicate()}><Copy size={16} strokeWidth={1.75} aria-hidden /> Duplicate</button>
            )}
            {!readOnly && persisted && (
              <button className="btn-ghost !text-alert" onClick={() => setConfirmDelete(true)}><Trash2 size={16} strokeWidth={1.75} aria-hidden /> Delete</button>
            )}
            {!readOnly && <button className="btn-primary" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Save size={16} strokeWidth={1.75} aria-hidden />} Save</button>}
          </div>
        </div>
        {readOnly && (
          <div className="banner-info flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2"><Lock size={15} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />{draft.builtIn ? "Library personas are read-only. Duplicate this one to make it yours." : "This team persona is read-only. Duplicate it to make your own editable copy."}</p>
            {persisted && <button className="btn-primary btn-sm" onClick={() => void duplicate()}><Copy size={14} strokeWidth={1.75} aria-hidden /> Duplicate to edit</button>}
          </div>
        )}
        {!readOnly && canShareWithOrg && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken/50 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 accent-[rgb(var(--primary))]" checked={sharedWithOrg} onChange={(e) => { setSharedWithOrg(e.target.checked); setSaved(false); }} />
            <span>
              <span className="flex items-center gap-1.5 font-semibold text-ink"><Users size={14} strokeWidth={1.75} className="text-primary" aria-hidden /> Share with my team</span>
              <span className="mt-0.5 block text-xs text-ink-soft">Lets everyone in your organization practice this persona and lets managers assign it.</span>
            </span>
          </label>
        )}
        {formError && <p role="alert" className="banner-alert font-medium">{formError}</p>}
        {saved && <p role="status" className="banner-ok flex items-center gap-2"><Check size={16} strokeWidth={1.75} className="shrink-0 text-ok" aria-hidden />{currentMeta?.stored === "database" ? "Saved to your account." : "Saved to this browser."}</p>}

        <fieldset disabled={readOnly} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2"><label className="label" htmlFor="t">Scenario title</label><input id="t" className={field} {...bad("title")} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />{msg("title")}</div>
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

          <section className="rounded-panel border border-line bg-sunken/50 p-4 sm:p-5" aria-labelledby="sec-persona">
            <h2 id="sec-persona" className="label !mb-3">AI persona</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="pn">Name</label><input id="pn" className={field} {...bad("aiPersona.name")} value={draft.aiPersona.name} onChange={(e) => patchPersona({ name: e.target.value })} />{msg("aiPersona.name")}</div>
              <div><label className="label" htmlFor="pr">Who they are</label><input id="pr" className={field} {...bad("aiPersona.role")} value={draft.aiPersona.role} onChange={(e) => patchPersona({ role: e.target.value })} />{msg("aiPersona.role")}</div>
            </div>
            <div className="mt-4"><label className="label" htmlFor="pb">Behavior (instructions to the AI caller)</label><textarea id="pb" rows={4} className={field} {...bad("aiPersona.behavior")} value={draft.aiPersona.behavior} onChange={(e) => patchPersona({ behavior: e.target.value })} />{msg("aiPersona.behavior")}</div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="po">Opening line</label><input id="po" className={field} {...bad("aiPersona.openingLine")} value={draft.aiPersona.openingLine} onChange={(e) => patchPersona({ openingLine: e.target.value })} />{msg("aiPersona.openingLine")}</div>
              <div><label className="label" htmlFor="pv">ElevenLabs voice ID (optional)</label><input id="pv" className={field} {...bad("aiPersona.voiceId")} value={draft.aiPersona.voiceId ?? ""} onChange={(e) => patchPersona({ voiceId: e.target.value || undefined })} />{msg("aiPersona.voiceId")}</div>
            </div>
          </section>

          <div><label className="label" htmlFor="g">Rep goal</label><textarea id="g" rows={2} className={field} {...bad("traineeGoal")} value={draft.traineeGoal} onChange={(e) => patch({ traineeGoal: e.target.value })} />{msg("traineeGoal")}</div>
          <div><label className="label" htmlFor="s">Talk track (one step per line)</label><textarea id="s" rows={6} className={field} {...bad("callScript")} value={draft.callScript} onChange={(e) => patch({ callScript: e.target.value })} />{msg("callScript")}</div>

          <section aria-labelledby="sec-rubric">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="sec-rubric" className="label !mb-1">Rubric</h2>
                <p className={`text-xs ${total === 100 ? "text-ink-muted" : "font-semibold text-caution"}`}>{total === 100 ? "Weights total 100%." : `Weights total ${total}%. Weights should add up to 100%. Scores are rescaled when graded.`}</p>
              </div>
              <div className="flex items-end gap-3">
                <p className={`mono text-2xl font-semibold leading-none ${total === 100 ? "text-ok" : "text-caution"}`} aria-hidden>{total}<span className="text-sm">%</span></p>
                {!readOnly && <button type="button" className="btn-ghost btn-sm !min-h-[36px]" onClick={() => patch({ rubric: [...draft.rubric, { id: `c${Date.now().toString(36)}`, name: "", description: "", weight: 10 }] })}><Plus size={14} strokeWidth={1.75} aria-hidden /> Criterion</button>}
              </div>
            </div>
            {/* The rubric as one spectrum: each criterion's share in its Debrief color, against the 100% scale. */}
            <div className="relative mb-3 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
              <div className="absolute inset-y-0 left-0 flex gap-px" style={{ width: `${Math.min(100, total)}%` }}>
                {draft.rubric.map((c, i) => <span key={c.id + i} className="h-full" style={{ flex: `${Math.max(Number(c.weight) || 0, 0.001)} 1 0%`, background: critHue(i) }} />)}
              </div>
            </div>
            <div className="space-y-3">
              {draft.rubric.map((c, i) => (
                <div key={c.id + i} className={`grid items-end gap-2 rounded-panel border p-3 sm:grid-cols-[1fr_100px_auto] ${Object.keys(errors).some((k) => k.startsWith(`rubric.${i}.`)) ? "border-alert bg-alert-soft/40" : "border-line"}`}>
                  <div>
                    <label htmlFor={`rn-${i}`} className="label !mb-1 flex items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: critHue(i) }} aria-hidden />Criterion {i + 1}</label>
                    <input id={`rn-${i}`} aria-label={`Criterion ${i + 1} name`} placeholder="Name" className={field} {...bad(`rubric.${i}.name`)} value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                    {msg(`rubric.${i}.name`)}
                  </div>
                  <div>
                    <label htmlFor={`rw-${i}`} className="label !mb-1 whitespace-nowrap">Weight (%)</label>
                    <input id={`rw-${i}`} aria-label={`Criterion ${i + 1} weight`} type="number" min={0} max={100} className={field} {...bad(`rubric.${i}.weight`)} value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                    {msg(`rubric.${i}.weight`)}
                  </div>
                  {!readOnly && <button type="button" aria-label={`Remove criterion ${i + 1}`} className="btn-ghost self-end !text-alert" disabled={draft.rubric.length <= 1} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={16} strokeWidth={1.75} aria-hidden /> Remove</button>}
                  <div className="tape sm:col-span-3" aria-hidden><span style={{ width: `${Math.min(100, Math.max(0, Number(c.weight) || 0))}%`, background: critHue(i) }} /></div>
                  <div className="sm:col-span-3"><textarea id={`rd-${i}`} aria-label={`Criterion ${i + 1} description`} placeholder="What good looks like" rows={2} className={field} {...bad(`rubric.${i}.description`)} value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />{msg(`rubric.${i}.description`)}</div>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="sec-obj">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="sec-obj" className="label !mb-1">Objections</h2>
                <p className="text-xs text-ink-muted">The live coach uses these to cue you with the prep answer.</p>
              </div>
              {!readOnly && <button type="button" className="btn-ghost btn-sm !min-h-[36px]" disabled={draft.objections.length >= 8} onClick={() => patch({ objections: [...draft.objections, { type: "price", line: "", prepAnswer: "" }] })}><Plus size={14} strokeWidth={1.75} aria-hidden /> Objection</button>}
            </div>
            <div className="space-y-3">
              {draft.objections.map((o, i) => (
                <div key={i} className="grid gap-2 rounded-panel border border-l-2 border-line border-l-alert/60 p-3 sm:grid-cols-[160px_1fr_auto]">
                  <select aria-label={`Objection ${i + 1} type`} className={field} value={o.type} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, type: e.target.value as Scenario["objections"][number]["type"] } : x)) })}>
                    {OBJECTION_TYPES.map((t) => <option key={t} value={t}>{OBJECTION_LABELS[t]}</option>)}
                  </select>
                  <input aria-label={`Objection ${i + 1} line`} placeholder="What the caller says" className={field} value={o.line} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)) })} />
                  {!readOnly && <button type="button" aria-label={`Remove objection ${i + 1}`} className="btn-ghost !text-alert" onClick={() => patch({ objections: draft.objections.filter((_, j) => j !== i) })}><Trash2 size={16} strokeWidth={1.75} aria-hidden /></button>}
                  <input aria-label={`Objection ${i + 1} prep answer`} placeholder="Prep answer the coach can suggest" className={`${field} sm:col-span-3`} value={o.prepAnswer} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, prepAnswer: e.target.value } : x)) })} />
                </div>
              ))}
              {draft.objections.length === 0 && <p className="text-xs text-ink-muted">No objections yet. Add the pushback this caller should raise.</p>}
            </div>
          </section>

          <div><label className="label" htmlFor="sr">Scripted caller replies for offline text simulation (one per line)</label>
            <textarea id="sr" rows={4} className={field} {...bad("sampleReplies")} value={draft.sampleReplies.join("\n")} onChange={(e) => patch({ sampleReplies: e.target.value.split("\n") })} />{msg("sampleReplies")}</div>
        </fieldset>
      </div>
      {confirmDelete && draft && (
        <ConfirmDialog title="Delete this scenario?" message={currentMeta?.stored === "database" ? `“${savedTitle}” will be removed from your account.` : `“${savedTitle}” will be removed from this browser.`} confirmLabel="Delete"
          onConfirm={() => {
            setConfirmDelete(false);
            void removeCustomScenario(draft.id, stored && isAuthenticated, currentMeta?.stored)
              .then(() => { clearErrors(); return refresh(listScenarios()[0].id); })
              .catch((e) => setFormError(e instanceof Error ? e.message : "Could not delete this persona."));
          }}
          onCancel={() => setConfirmDelete(false)} />
      )}
      {/* Below md the toast clears the bottom tab bar (56 px plus the safe-area inset). */}
      {toast && createPortal(
        <div className="pointer-events-none fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[100] flex justify-center md:bottom-4">
          <div role="status" className="flex max-w-md items-center gap-2 rounded-lg bg-ink px-4 py-3 text-sm text-background shadow-pop motion-safe:animate-sheet-up"><Check size={15} strokeWidth={1.75} aria-hidden />{toast}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

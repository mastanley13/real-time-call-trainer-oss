"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Globe, Loader2, Play, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { CALL_TYPES, CALL_TYPE_LABELS, JOB_FAMILIES, OBJECTION_LABELS, OBJECTION_TYPES, ScenarioSchema, type CallType, type ObjectionType, type Scenario } from "@/lib/scenarios";
import { CONTEXT_KINDS, CONTEXT_LABELS, type ContextKind, type FetchedPage, type FieldSource, type WizardInput, type WizardOutput } from "@/lib/wizard-types";
import { saveCustomScenario } from "@/lib/scenarioStore";
import { useAuth } from "@/contexts/AuthContext";
import { radioKeys } from "@/components/call/CopilotRail";
import { packJson } from "./LibraryClient";

const STEPS = ["What you sell", "Give context", "Review persona", "Rubric", "Save"] as const;
const PLACEHOLDERS: Record<ContextKind, string> = {
  job: "Paste the job description for the rep role, e.g. “SDR, logistics SaaS. Book 12 meetings a month with VP Ops at mid-size freight brokers…”",
  url: "Paste a product or pricing page URL and press Import, or paste the page text here.",
  crm: "Paste CRM notes, e.g. “Marcus Bell, VP Finance at Ridgeway Freight. Invoice disputes eat ~2 FTE. Uses Excel + NetSuite. No new spend until Q4.”",
  icp: "Describe the ideal customer: company size, buyer title, pains, what they use today.",
  call: "Paste a real call transcript (remove names and personal details first).",
};

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

/** Plain names for the fields a schema issue can point at. */
const FIELD_LABELS: Record<string, string> = {
  id: "Persona id", title: "Scenario title", industry: "Industry", callScript: "Talk track", traineeGoal: "Rep goal",
  "aiPersona.name": "Name", "aiPersona.role": "Who they are", "aiPersona.behavior": "Behavior", "aiPersona.openingLine": "Opening line", rubric: "Rubric", objections: "Objections",
};
const NEEDS: Record<string, string> = { "aiPersona.name": "the persona's name", title: "a title", line: "what the buyer says", name: "a name", id: "an id", rubric: "at least one criterion" };

/** A schema issue as one plain sentence that names the field and says how to fix it, e.g. "Name: add the persona's name." */
export function issueText(issue: { path: (string | number)[]; code: string; maximum?: number | bigint }): string {
  const [head, idx, field] = issue.path;
  const key = issue.path.join(".");
  const item = typeof idx === "number" && typeof field === "string";
  const label = item && head === "objections" ? `Objection ${idx + 1}${field === "prepAnswer" ? " prep answer" : ""}`
    : item && head === "rubric" ? `Criterion ${idx + 1} ${field === "description" ? "description" : field === "weight" ? "weight" : "name"}`
    : FIELD_LABELS[key] ?? "One field";
  if (issue.code === "too_small") return `${label}: add ${NEEDS[key] ?? NEEDS[String(field)] ?? "some text"}.`;
  if (issue.code === "too_big") return `${label}: shorten it to ${Number(issue.maximum)} ${key === "rubric" || key === "objections" ? "items" : "characters"} or fewer.`;
  return `${label}: check this value and try again.`;
}

/**
 * Where a field came from. A button outside the field's label, so it doesn't become part of the
 * input's name; the quoted snippet is its description and opens on hover, focus, click or tap.
 */
function SourceChip({ src }: { src?: FieldSource }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pressing = useRef(false);
  if (!src) return null;
  const label = src.kind === "chips" ? "Your picks" : src.kind === "model" ? "Model" : CONTEXT_LABELS[src.kind];
  return (
    <span className="relative inline-flex" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" className="inline-flex cursor-help items-center rounded border border-primary/40 bg-primary-soft/50 px-1.5 font-mono text-[10px] font-medium text-primary"
        aria-describedby={src.snippet ? id : undefined}
        // Keyboard focus shows the snippet; a click or tap toggles it (a press focuses first, so focus alone must not toggle it).
        onPointerDown={() => { pressing.current = true; }}
        onFocus={() => { if (!pressing.current) setPinned(true); pressing.current = false; }}
        onClick={() => { pressing.current = false; setPinned((p) => !p); }}
        onBlur={() => setPinned(false)}
        onKeyDown={(e) => { if (e.key === "Escape" && (pinned || hover)) { e.stopPropagation(); setPinned(false); setHover(false); } }}>
        <span className="sr-only">Source: </span>{label}
      </button>
      {src.snippet && (
        <span id={id} role="tooltip" className={`absolute bottom-full left-0 z-10 mb-1 w-64 max-w-[80vw] rounded-md border border-line bg-surface p-2 text-[11px] font-normal normal-case text-ink shadow-pop ${pinned || hover ? "block" : "hidden"}`}>&ldquo;{src.snippet}&rdquo;</span>
      )}
    </span>
  );
}

/** A field label with its source chip beside it, outside the label element. */
function FieldLabel({ htmlFor, src, children }: { htmlFor: string; src?: FieldSource; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
      <label className="label !mb-0" htmlFor={htmlFor}>{children}</label>
      <SourceChip src={src} />
    </div>
  );
}

export default function PersonaWizard() {
  const { capabilities, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<WizardInput>({ role: "sdr", industry: "", callType: "cold", difficulty: "medium", product: "", contexts: [] });
  const [contexts, setContexts] = useState<Record<ContextKind, string>>({ job: "", url: "", crm: "", icp: "", call: "" });
  const [tab, setTab] = useState<ContextKind>("crm");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<FetchedPage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [out, setOut] = useState<WizardOutput | null>(null);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isLoading && capabilities && !isAuthenticated) router.replace("/login");
  }, [isLoading, capabilities, isAuthenticated, router]);

  // On phones the step list scrolls sideways: keep the current step in view as the wizard moves on.
  const stepList = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const ol = stepList.current;
    const cur = ol?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!ol || !cur || ol.scrollWidth <= ol.clientWidth) return;
    ol.scrollLeft += cur.getBoundingClientRect().left - ol.getBoundingClientRect().left - 8;
  }, [step]);

  const filled = CONTEXT_KINDS.filter((k) => contexts[k].trim().length > 0);
  const validation = useMemo(() => (draft ? ScenarioSchema.safeParse(draft) : null), [draft]);
  const issues = validation && !validation.success ? [...new Set(validation.error.issues.map(issueText))].slice(0, 4) : [];
  const total = draft ? Math.round(draft.rubric.reduce((a, c) => a + (Number(c.weight) || 0), 0)) : 0;
  const canNext = [
    input.role && (input.product.trim() || input.industry.trim()),
    filled.length > 0 || input.product.trim().length > 20,
    !!draft && !!validation?.success,
    !!draft && total === 100 && draft.rubric.length >= 3,
    true,
  ][step];

  async function importUrl() {
    if (fetching) return;
    setFetching(true); setError("");
    try {
      const res = await fetch("/api/persona/fetch-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "That page couldn't be imported.");
      setFetched(data);
      setContexts((c) => ({ ...c, url: `${data.title ? `${data.title}\n\n` : ""}${data.text}` }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That page couldn't be imported.");
    } finally {
      setFetching(false);
    }
  }

  async function generate() {
    if (generating) return;
    setGenerating(true); setError("");
    const body: WizardInput = { ...input, contexts: filled.map((k) => ({ kind: k, text: contexts[k].slice(0, 8000), ...(k === "url" && fetched ? { label: fetched.url } : {}) })) };
    try {
      const res = await fetch("/api/persona/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "The wizard couldn't draft this persona.");
      setOut(data);
      setDraft(data.scenario);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The wizard couldn't draft this persona.");
    } finally {
      setGenerating(false);
    }
  }

  const patch = (p: Partial<Scenario>) => draft && setDraft({ ...draft, ...p });
  const patchPersona = (p: Partial<Scenario["aiPersona"]>) => draft && setDraft({ ...draft, aiPersona: { ...draft.aiPersona, ...p } });
  const src = (path: string) => out?.sources[path];

  function balance() {
    if (!draft) return;
    const sum = draft.rubric.reduce((a, c) => a + (Number(c.weight) || 0), 0) || 1;
    const scaled = draft.rubric.map((c) => ({ ...c, weight: Math.round(((Number(c.weight) || 0) / sum) * 100) }));
    const drift = 100 - scaled.reduce((a, c) => a + c.weight, 0);
    scaled[0].weight += drift;
    patch({ rubric: scaled });
  }

  function savePrivate(thenPractise: boolean) {
    if (!draft || !validation?.success) return;
    saveCustomScenario({ ...validation.data, builtIn: false });
    setSaved(true);
    if (thenPractise) router.push(`/trainer?scenario=${encodeURIComponent(draft.id)}`);
  }

  async function copyPack() {
    if (!draft) return;
    try { await navigator.clipboard.writeText(packJson({ ...draft, status: "draft" })); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the JSON is visible to copy by hand */ }
  }

  if (!capabilities) return null;

  return (
    <div className="page enter">
      <Link href="/library" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink"><ArrowLeft size={15} aria-hidden /> Library</Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AI persona wizard</p>
          <h1 className="mt-1 text-3xl font-bold">New persona</h1>
        </div>
        <span className="chip-model"><Sparkles size={12} aria-hidden /> {out ? (out.method === "llm" ? `Generated with ${out.model ?? capabilities.model}` : "Template draft (AI unavailable)") : capabilities.llm ? `Drafts with ${capabilities.model ?? "your model"}` : "Template drafts (no AI key on this server)"}</span>
      </div>

      {/* minmax(0,1fr) and min-w-0: the step list scrolls sideways on phones instead of widening the page. */}
      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Wizard steps" className="min-w-0">
          <ol ref={stepList} className="flex gap-2 overflow-x-auto lg:flex-col lg:gap-1">
            {STEPS.map((s, i) => {
              const done = i < step;
              const reachable = i <= step || (i <= 4 && !!draft && i >= 2);
              return (
                <li key={s} className="shrink-0">
                  <button disabled={!reachable} onClick={() => setStep(i)} aria-current={i === step ? "step" : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-50 ${i === step ? "bg-surface font-semibold shadow-card ring-1 ring-line" : "hover:bg-sunken"}`}>
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${done ? "border-ok bg-ok text-background" : i === step ? "border-primary text-primary" : "border-line text-ink-muted"}`}>{done ? <Check size={13} strokeWidth={3} aria-hidden /> : i + 1}</span>
                    {s}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0 space-y-5">
          {error && <p role="alert" className="rounded-lg border border-alert/40 bg-alert-soft p-3 text-sm">{error}</p>}

          {step === 0 && (
            <section className="card space-y-6">
              <div>
                <p className="label">Sales job</p>
                <div className="flex flex-wrap gap-1.5">
                  {JOB_FAMILIES.map((f) => (
                    <button key={f.id} aria-pressed={input.role === f.id} onClick={() => setInput({ ...input, role: f.id })}
                      className={`chip ${input.role === f.id ? "!border-primary bg-primary-soft !text-ink" : "hover:border-ink-muted"}`}>{f.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <p className="label">Call type</p>
                <div className="flex flex-wrap gap-1.5">
                  {CALL_TYPES.map((c) => (
                    <button key={c} aria-pressed={input.callType === c} onClick={() => setInput({ ...input, callType: c as CallType })}
                      className={`chip ${input.callType === c ? "!border-primary bg-primary-soft !text-ink" : "hover:border-ink-muted"}`}>{CALL_TYPE_LABELS[c]}</button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className="label" htmlFor="w-ind">Industry</label><input id="w-ind" className="input" placeholder="e.g. Logistics SaaS" value={input.industry} onChange={(e) => setInput({ ...input, industry: e.target.value })} /></div>
                <div>
                  <p className="label">Difficulty</p>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-sunken p-1" role="radiogroup" aria-label="Difficulty" onKeyDown={radioKeys(DIFFICULTIES, input.difficulty, (d) => setInput({ ...input, difficulty: d }))}>
                    {DIFFICULTIES.map((d) => (
                      <button key={d} type="button" role="radio" aria-checked={input.difficulty === d} tabIndex={input.difficulty === d ? 0 : -1} onClick={() => setInput({ ...input, difficulty: d })}
                        className={`rounded-md py-1.5 text-sm font-semibold capitalize ${input.difficulty === d ? "bg-surface shadow-card ring-1 ring-line" : "text-ink-muted"}`}>{d}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div><label className="label" htmlFor="w-prod">What are you selling?</label><textarea id="w-prod" rows={3} className="input" placeholder="e.g. RouteLoop automates freight invoice disputes for mid-size brokers. $1,200/month, 30-day pilot." value={input.product} onChange={(e) => setInput({ ...input, product: e.target.value })} /></div>
            </section>
          )}

          {step === 1 && (
            <section className="card space-y-4">
              <p className="text-sm text-ink-soft">Add one or more sources. The wizard grounds the persona in them and shows which source each field came from.</p>
              <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Context sources" onKeyDown={radioKeys(CONTEXT_KINDS, tab, setTab)}>
                {CONTEXT_KINDS.map((k) => (
                  <button key={k} id={`ctx-tab-${k}`} type="button" role="tab" aria-selected={tab === k} aria-controls="ctx-panel" tabIndex={tab === k ? 0 : -1} onClick={() => setTab(k)}
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-primary text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}>
                    {contexts[k].trim() && <Check size={13} className="text-ok" aria-label="added" />}{CONTEXT_LABELS[k]}
                  </button>
                ))}
              </div>
              <div id="ctx-panel" role="tabpanel" aria-labelledby={`ctx-tab-${tab}`} className="space-y-4">
                {tab === "url" && (
                  <div className="flex gap-2">
                    <label className="relative flex-1">
                      <span className="sr-only">Product page URL</span>
                      <Globe size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
                      <input className="input !pl-9" type="url" placeholder="https://example.com/pricing" value={url} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    {/* aria-disabled while busy, so the focused button keeps focus instead of dropping it to the page. */}
                    <button type="button" className="btn-ghost" onClick={importUrl} disabled={!fetching && !/^https?:\/\//.test(url)} aria-disabled={fetching}>{fetching ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null} Import</button>
                  </div>
                )}
                {tab === "url" && fetched && <p className="font-mono text-[11px] text-ok">Imported {fetched.title || fetched.url} · {(fetched.bytes / 1024).toFixed(0)} KB · public pages only, private addresses are blocked</p>}
                <textarea aria-label={CONTEXT_LABELS[tab]} rows={10} className="input font-mono !text-[13px]" placeholder={PLACEHOLDERS[tab]} value={contexts[tab]} onChange={(e) => setContexts({ ...contexts, [tab]: e.target.value })} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[11px] text-ink-muted">{contexts[tab].length.toLocaleString()} / 8,000 chars · {filled.length} source{filled.length === 1 ? "" : "s"} added</p>
                <button type="button" className="btn-primary" onClick={generate} disabled={!generating && !canNext} aria-disabled={generating}>{generating ? <><Loader2 size={16} className="animate-spin" aria-hidden /> Drafting persona…</> : <><Sparkles size={16} aria-hidden /> Draft persona</>}</button>
              </div>
            </section>
          )}

          {step === 2 && draft && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <section className="card space-y-4">
                {out?.method === "template" && <p className="banner-warn">Template draft: AI generation wasn&rsquo;t available (no working AI key), so this persona was assembled from your picks and the first lines of your context. Edit freely.</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><FieldLabel htmlFor="d-name" src={src("aiPersona.name")}>Name</FieldLabel><input id="d-name" className="input" value={draft.aiPersona.name} onChange={(e) => patchPersona({ name: e.target.value })} /></div>
                  <div><FieldLabel htmlFor="d-title" src={src("title")}>Scenario title</FieldLabel><input id="d-title" className="input" value={draft.title} onChange={(e) => patch({ title: e.target.value })} /></div>
                </div>
                <div><FieldLabel htmlFor="d-role" src={src("aiPersona.role")}>Who they are</FieldLabel><input id="d-role" className="input" value={draft.aiPersona.role} onChange={(e) => patchPersona({ role: e.target.value })} /></div>
                <div><FieldLabel htmlFor="d-beh" src={src("aiPersona.behavior")}>Behavior (instructions to the AI caller)</FieldLabel><textarea id="d-beh" rows={6} className="input" value={draft.aiPersona.behavior} onChange={(e) => patchPersona({ behavior: e.target.value })} /></div>
                <div><FieldLabel htmlFor="d-open" src={src("aiPersona.openingLine")}>Opening line</FieldLabel><input id="d-open" className="input" value={draft.aiPersona.openingLine} onChange={(e) => patchPersona({ openingLine: e.target.value })} /></div>
                <div><FieldLabel htmlFor="d-goal" src={src("traineeGoal")}>Rep goal</FieldLabel><textarea id="d-goal" rows={2} className="input" value={draft.traineeGoal} onChange={(e) => patch({ traineeGoal: e.target.value })} /></div>
                <div><FieldLabel htmlFor="d-script" src={src("callScript")}>Talk track (one step per line)</FieldLabel><textarea id="d-script" rows={6} className="input" value={draft.callScript} onChange={(e) => patch({ callScript: e.target.value })} /></div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="label !mb-0">Objections</p>
                    <button className="btn-quiet btn-sm" disabled={draft.objections.length >= 8} onClick={() => patch({ objections: [...draft.objections, { type: "price", line: "", prepAnswer: "" }] })}><Plus size={13} aria-hidden /> Objection</button>
                  </div>
                  <div className="space-y-2">
                    {draft.objections.map((o, i) => (
                      <div key={i} className="rounded-lg border border-line p-3">
                        <div className="flex items-center gap-2">
                          <select aria-label={`Objection ${i + 1} type`} className="input !w-auto !py-1.5" value={o.type} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, type: e.target.value as ObjectionType } : x)) })}>
                            {OBJECTION_TYPES.map((t) => <option key={t} value={t}>{OBJECTION_LABELS[t]}</option>)}
                          </select>
                          <SourceChip src={src(`objections.${i}`)} />
                          <button className="btn-quiet btn-sm ml-auto !px-2" aria-label={`Remove objection ${i + 1}`} onClick={() => patch({ objections: draft.objections.filter((_, j) => j !== i) })}><Trash2 size={14} aria-hidden /></button>
                        </div>
                        <input aria-label={`Objection ${i + 1} line`} className="input mt-2" placeholder="What they say" value={o.line} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)) })} />
                        <input aria-label={`Objection ${i + 1} prep answer`} className="input mt-2" placeholder="A strong answer for the coach to suggest" value={o.prepAnswer} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, prepAnswer: e.target.value } : x)) })} />
                      </div>
                    ))}
                  </div>
                </div>
              </section>
              <PackPreview draft={draft} valid={!!validation?.success} issues={issues} model={out?.method === "llm" ? out.model : undefined} />
            </div>
          )}

          {step === 3 && draft && (
            <section className="card space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink-soft">Weights decide how much each criterion counts in the grade and in the live estimate.</p>
                <span className={`mono rounded-md px-2 py-1 text-sm font-semibold ${total === 100 ? "bg-ok-soft text-ok" : "bg-caution-soft text-caution"}`}>Total {total}%</span>
              </div>
              {total !== 100 && <button className="btn-ghost btn-sm" onClick={balance}>Balance to 100%</button>}
              <ul className="space-y-3">
                {draft.rubric.map((c, i) => (
                  <li key={c.id + i} className="rounded-lg border border-line p-3">
                    <div className="flex items-center gap-3">
                      <input aria-label={`Criterion ${i + 1} name`} className="input flex-1 !py-1.5 font-semibold" value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                      <span className="mono w-12 text-right text-sm">{c.weight}%</span>
                      <button className="btn-quiet btn-sm !px-2" aria-label={`Remove criterion ${i + 1}`} disabled={draft.rubric.length <= 3} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={14} aria-hidden /></button>
                    </div>
                    <input type="range" min={0} max={60} step={1} aria-label={`Criterion ${i + 1} weight`} className="mt-2 w-full accent-[rgb(var(--primary))]" value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                    <input aria-label={`Criterion ${i + 1} description`} className="input mt-1 !text-[13px]" placeholder="What good looks like, in observable terms" value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />
                  </li>
                ))}
              </ul>
              <button className="btn-ghost btn-sm" disabled={draft.rubric.length >= 7} onClick={() => patch({ rubric: [...draft.rubric, { id: `c${draft.rubric.length + 1}-${Date.now().toString(36)}`, name: "New criterion", description: "", weight: 0 }] })}><Plus size={13} aria-hidden /> Criterion</button>
            </section>
          )}

          {step === 4 && draft && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <section className="card space-y-5">
                <div>
                  <h2 className="text-lg font-bold">Keep it private</h2>
                  <p className="mt-1 text-sm text-ink-soft">Saves to this browser&rsquo;s library under &ldquo;Your personas&rdquo;. Run a test call to check the persona behaves before you share it.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => savePrivate(true)} disabled={!validation?.success}><Play size={15} aria-hidden /> Save and test call</button>
                    <button className="btn-ghost" onClick={() => savePrivate(false)} disabled={!validation?.success}><Save size={15} aria-hidden /> {saved ? "Saved" : "Save only"}</button>
                  </div>
                </div>
                <div className="border-t border-line pt-5">
                  <h2 className="text-lg font-bold">Contribute it as a pack</h2>
                  <p className="mt-1 text-sm text-ink-soft">Copy the pack file, add it to <span className="mono text-[13px]">src/lib/personas/{draft.role}.ts</span>, and open a pull request. It starts as a draft until a maintainer reviews it; CI checks it against the same schema.</p>
                  <button className="btn-ghost mt-3" onClick={copyPack}><Copy size={15} aria-hidden /> {copied ? "Copied" : "Copy pack JSON"}</button>
                </div>
              </section>
              <PackPreview draft={{ ...draft, status: "draft" }} valid={!!validation?.success} issues={[]} model={out?.method === "llm" ? out.model : undefined} />
            </div>
          )}

          {step < 4 && (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button type="button" className="btn-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><ArrowLeft size={15} aria-hidden /> Back</button>
              {step === 1 ? null : (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  {/* Why Next is off on the review step, in plain words next to the button. */}
                  {step === 2 && issues.length > 0 && (
                    <div className="text-right text-sm" role="status">
                      <p className="font-semibold text-caution">Fix these to continue:</p>
                      <ul className="text-ink-soft">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
                    </div>
                  )}
                  <button type="button" className="btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>Next <ArrowRight size={15} aria-hidden /></button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PackPreview({ draft, valid, issues, model }: { draft: Scenario; valid: boolean; issues: string[]; model?: string }) {
  return (
    <aside className="deck min-w-0 self-start overflow-hidden rounded-panel border border-line xl:sticky xl:top-[calc(var(--header-h,3.5rem)+1rem)]">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <p className="truncate font-mono text-[11px] text-ink-soft">{draft.id}.json</p>
        <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${valid ? "text-ok" : "text-caution"}`}><span className={`lamp ${valid ? "lamp-ok" : "lamp-caution"} !h-1.5 !w-1.5`} aria-hidden />{valid ? "schema valid" : "needs fixes"}</span>
      </div>
      {issues.length > 0 && <ul className="border-b border-line bg-caution-soft px-3 py-2 font-mono text-[11px] text-ink">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      <pre className="scroll-thin max-h-[70vh] overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink-soft">{packJson(draft)}</pre>
      {model && <p className="border-t border-line px-3 py-2 font-mono text-[10px] text-ink-muted">Generated with {model} · structured JSON, checked with zod</p>}
    </aside>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Globe, Library, Loader2, Lock, Play, Plus, Save, Sparkles, Trash2, Users } from "lucide-react";
import { CALL_TYPES, CALL_TYPE_LABELS, JOB_FAMILIES, OBJECTION_LABELS, OBJECTION_TYPES, ScenarioSchema, type CallType, type ObjectionType, type Scenario } from "@/lib/scenarios";
import { LIVE_CAST_VOICES } from "@/lib/liveCasting";
import { CONTEXT_KINDS, CONTEXT_LABELS, type ContextKind, type FetchedPage, type FieldSource, type WizardInput, type WizardOutput } from "@/lib/wizard-types";
import { buildQuickStartInput, formatFetchedPageContext, inferCallTypeForRole, inferRoleFromPage, normalizeWizardUrl } from "@/lib/wizardQuickStart";
import { persistCustomScenario } from "@/lib/scenarioStore";
import { useAuth } from "@/contexts/AuthContext";
import { radioKeys } from "@/components/call/CopilotRail";
import { FormSkeleton } from "@/components/ui/Skeleton";
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

/** Categorical criterion hue (--cat-1 to --cat-8), in the same order the Library strip and the Debrief use. */
const critHue = (i: number) => `rgb(var(--cat-${(i % 8) + 1}))`;

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
  const label = src.kind === "chips" ? "Your picks" : src.kind === "model" ? "AI draft" : CONTEXT_LABELS[src.kind];
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
  const { user, capabilities, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<WizardInput>({ role: "sdr", industry: "", callType: "cold", difficulty: "medium", product: "", contexts: [], keepRealNames: true });
  const [contexts, setContexts] = useState<Record<ContextKind, string>>({ job: "", url: "", crm: "", icp: "", call: "" });
  const [tab, setTab] = useState<ContextKind>("url");
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<FetchedPage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [quickStage, setQuickStage] = useState<"fetch" | "generate" | "save" | null>(null);
  const [rolePicked, setRolePicked] = useState(false);
  const [callTypePicked, setCallTypePicked] = useState(false);
  const [sharedWithOrg, setSharedWithOrg] = useState(false);
  const [savedStorage, setSavedStorage] = useState<"database" | "local" | null>(null);
  const [out, setOut] = useState<WizardOutput | null>(null);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const stored = !!capabilities?.database && !capabilities?.demoMode;
  const canShareWithOrg = stored && (user?.role === "manager" || user?.role === "owner" || !!user?.isPlatformAdmin);
  const wizardHasAi = !!capabilities?.llm;
  const busy = fetching || generating || saving || quickStage !== null;

  useEffect(() => {
    if (!isLoading && capabilities && !isAuthenticated) {
      const next = typeof window !== "undefined" ? `/library/new${window.location.search}` : "/library/new";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [isLoading, capabilities, isAuthenticated, router]);

  // Support /library/new?url=https://example.com so landing pages or links can drop a site straight in.
  const urlQueryLoaded = useRef(false);
  useEffect(() => {
    if (urlQueryLoaded.current || typeof window === "undefined") return;
    urlQueryLoaded.current = true;
    const raw = new URLSearchParams(window.location.search).get("url")?.trim();
    if (raw) setUrl(raw);
  }, []);

  // Each step change moves focus to the new step's heading, so keyboard and screen reader users land on what changed.
  // Not on first render: the page's own h1 leads then.
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    stepHeading.current?.focus();
  }, [step]);

  const filled = CONTEXT_KINDS.filter((k) => contexts[k].trim().length > 0);
  const validation = useMemo(() => (draft ? ScenarioSchema.safeParse(draft) : null), [draft]);
  const issues = validation && !validation.success ? [...new Set(validation.error.issues.map(issueText))].slice(0, 4) : [];
  const total = draft ? Math.round(draft.rubric.reduce((a, c) => a + (Number(c.weight) || 0), 0)) : 0;
  const canNext = [
    Boolean(input.role && (input.product.trim() || input.industry.trim() || contexts.url.trim())),
    filled.length > 0 || input.product.trim().length > 20,
    !!draft && !!validation?.success,
    !!draft && total === 100 && draft.rubric.length >= 3,
    true,
  ][step];
  /** Why Next is off on the rubric step, in plain words. */
  const rubricReason = step === 3 && draft && !canNext
    ? draft.rubric.length < 3 ? "Add at least 3 criteria to continue." : `Weights add up to ${total}%. Make them total 100% to continue.`
    : "";

  async function fetchPage(rawUrl: string): Promise<FetchedPage> {
    const target = normalizeWizardUrl(rawUrl);
    if (!target) throw new Error("Paste a website URL first.");
    setUrl(target);
    const res = await fetch("/api/persona/fetch-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    const data = (await res.json()) as FetchedPage & { message?: string };
    if (!res.ok) throw new Error(data.message || "That page couldn't be imported.");
    setFetched(data);
    setContexts((c) => ({ ...c, url: formatFetchedPageContext(data) }));
    const inferredRole = rolePicked ? input.role : inferRoleFromPage(data);
    const inferredCallType = callTypePicked ? input.callType : inferCallTypeForRole(inferredRole, input.callType);
    setInput((prev) => ({
      ...prev,
      role: rolePicked ? prev.role : inferredRole,
      callType: callTypePicked ? prev.callType : inferredCallType,
      product: prev.product.trim() ? prev.product : (data.suggestedProduct || data.description || data.title || prev.product).slice(0, 400),
      industry: prev.industry.trim() ? prev.industry : (data.suggestedIndustry || prev.industry).slice(0, 80),
    }));
    return data;
  }

  async function importUrl() {
    if (busy) return;
    if (!normalizeWizardUrl(url)) return;
    setFetching(true);
    setError("");
    try {
      await fetchPage(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That page couldn't be imported.");
    } finally {
      setFetching(false);
    }
  }

  function currentWizardBody(): WizardInput {
    return {
      ...input,
      keepRealNames: input.keepRealNames ?? true,
      contexts: filled.map((k) => ({ kind: k, text: contexts[k].slice(0, 8000), ...(k === "url" && fetched ? { label: fetched.url } : {}) })),
    };
  }

  async function requestPersona(body: WizardInput): Promise<WizardOutput> {
    const res = await fetch("/api/persona/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "The wizard couldn't draft this persona.");
    return data as WizardOutput;
  }

  async function generate() {
    if (busy) return;
    setGenerating(true);
    setError("");
    try {
      const data = await requestPersona(currentWizardBody());
      setOut(data);
      setDraft(data.scenario);
      setSaved(false);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The wizard couldn't draft this persona.");
    } finally {
      setGenerating(false);
    }
  }

  /** One-click path: fetch URL (if needed) -> draft buyer and rubric -> save -> open the live call briefing. */
  async function quickStartFromUrl() {
    if (busy) return;
    const target = normalizeWizardUrl(url);
    if (!target) return;
    setError("");
    let generatedScenario: Scenario | null = null;
    try {
      let page = fetched;
      if (!page || (page.url !== target && normalizeWizardUrl(page.url) !== target)) {
        setQuickStage("fetch");
        page = await fetchPage(target);
      }
      const extraContexts = CONTEXT_KINDS
        .filter((k) => k !== "url" && contexts[k].trim().length > 0)
        .map((k) => ({ kind: k, text: contexts[k].slice(0, 8000) }));
      const body = buildQuickStartInput(page, input, { rolePicked, callTypePicked, extraContexts });

      setQuickStage("generate");
      const data = await requestPersona(body);
      generatedScenario = data.scenario;
      setOut(data);
      setDraft(data.scenario);
      setSaved(false);

      setQuickStage("save");
      const result = await persistCustomScenario({
        scenario: { ...data.scenario, builtIn: false },
        useDatabase: stored,
        sharedWithOrg: canShareWithOrg ? sharedWithOrg : false,
        keepRealNames: body.keepRealNames ?? true,
        sourceUrl: page.url,
      });
      setDraft(result.scenario);
      setSavedStorage(result.meta.stored);
      setSaved(true);
      router.push(`/trainer?scenario=${encodeURIComponent(result.scenario.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build a training call from that URL. Try importing and customizing it below.");
      // If the persona was already generated before save failed, keep it open in Review so the user doesn't lose work.
      if (generatedScenario) setStep(2);
    } finally {
      setQuickStage(null);
    }
  }

  /** One-click launch from Step 2 after adding extra context tabs (CRM notes, ICP, job description, call). */
  async function quickStartFromContext() {
    if (busy || !canNext) return;
    setError("");
    let generatedScenario: Scenario | null = null;
    try {
      const body = currentWizardBody();
      setQuickStage("generate");
      const data = await requestPersona(body);
      generatedScenario = data.scenario;
      setOut(data);
      setDraft(data.scenario);
      setSaved(false);

      setQuickStage("save");
      const result = await persistCustomScenario({
        scenario: { ...data.scenario, builtIn: false },
        useDatabase: stored,
        sharedWithOrg: canShareWithOrg ? sharedWithOrg : false,
        keepRealNames: body.keepRealNames ?? true,
        sourceUrl: fetched?.url ?? null,
      });
      setDraft(result.scenario);
      setSavedStorage(result.meta.stored);
      setSaved(true);
      router.push(`/trainer?scenario=${encodeURIComponent(result.scenario.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The wizard couldn't build this persona.");
      if (generatedScenario) setStep(2);
    } finally {
      setQuickStage(null);
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

  async function savePrivate(thenPractice: boolean) {
    if (!draft || !validation?.success || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await persistCustomScenario({
        scenario: { ...validation.data, builtIn: false },
        useDatabase: stored,
        sharedWithOrg: canShareWithOrg ? sharedWithOrg : false,
        keepRealNames: input.keepRealNames ?? true,
        sourceUrl: fetched?.url ?? null,
      });
      setDraft(result.scenario);
      setSavedStorage(result.meta.stored);
      setSaved(true);
      if (thenPractice) router.push(`/trainer?scenario=${encodeURIComponent(result.scenario.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this persona. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copyPack() {
    if (!draft) return;
    try { await navigator.clipboard.writeText(packJson({ ...draft, status: "draft" })); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the JSON is visible to copy by hand */ }
  }

  if (!capabilities) return <FormSkeleton />;

  return (
    <div className="page enter">
      <Link href="/library" className="inline-flex min-h-[40px] items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink"><ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> Library</Link>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">AI persona wizard</p>
          <h1 className="mt-1 text-3xl font-bold">New persona</h1>
        </div>
        <span className="chip-model"><Sparkles size={12} strokeWidth={1.75} aria-hidden /> {out ? (out.method === "llm" ? "Generated with AI" : "Template draft (AI unavailable)") : wizardHasAi ? "Drafts with AI" : "Template drafts (no AI key on this server)"}</span>
      </div>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
        {/* Phones: a 5-segment tape for progress; the step heading below names the step. */}
        <div className="flex gap-1 lg:hidden" aria-hidden>
          {STEPS.map((s, i) => <div key={s} className="tape flex-1"><span className={i < step ? "w-full bg-ok" : i === step ? "w-full bg-primary" : "w-0"} /></div>)}
        </div>
        {/* lg and up: the flight plan, a vertical rail with a lamp on the active leg and a check on finished ones. */}
        <nav aria-label="Wizard steps" className="hidden min-w-0 lg:block">
          <ol className="relative space-y-1 before:absolute before:bottom-5 before:left-[22px] before:top-5 before:w-px before:bg-line">
            {STEPS.map((s, i) => {
              const done = i < step;
              const current = i === step;
              const reachable = i <= step || (i <= 4 && !!draft && i >= 2);
              return (
                <li key={s} className="relative">
                  <button disabled={!reachable} onClick={() => setStep(i)} aria-current={current ? "step" : undefined}
                    className={`flex min-h-[44px] w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-50 ${current ? "bg-surface font-semibold text-ink shadow-card ring-1 ring-line" : "text-ink-soft hover:bg-sunken"}`}>
                    <span className={`relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${done ? "border-ok bg-ok-soft text-ok" : current ? "border-primary/60 bg-surface" : "border-line bg-background text-ink-muted"}`}>
                      {done ? <Check size={13} strokeWidth={1.75} aria-hidden /> : current ? <span className="lamp lamp-signal !h-2 !w-2" aria-hidden /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">{s}{done && <span className="sr-only"> (done)</span>}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0 space-y-5">
          <div>
            <h2 ref={stepHeading} tabIndex={-1} className="text-xl font-bold outline-none focus-visible:outline-2 sm:text-2xl">
              <span className="mono mr-2 text-base font-medium text-ink-muted">Step {step + 1} of {STEPS.length}:</span>{STEPS[step]}
            </h2>
          </div>
          {error && <p role="alert" className="banner-alert">{error}</p>}

          {step === 0 && (
            <section className="card space-y-6">
              <div className="rounded-panel border border-primary/35 bg-primary-soft/30 p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="label !mb-0 flex items-center gap-1.5 text-ink"><Globe size={14} strokeWidth={1.75} className="text-primary" aria-hidden /> Start a training call from one URL</p>
                  <span className="font-mono text-[11px] text-ink-muted">1 click to call, or customize below</span>
                </div>
                <p className="mt-1.5 text-sm text-ink-soft">Paste any company, product, or pricing page. Launch a live call right away, or import it first to customize the buyer and add more context.</p>
                <div className="mt-3 flex flex-col gap-2">
                  <label className="relative min-w-0 flex-1">
                    <span className="sr-only">Website URL</span>
                    <Globe size={15} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
                    <input
                      className="input !pl-9"
                      type="text"
                      inputMode="url"
                      placeholder="https://yourcompany.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void quickStartFromUrl(); } }}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary flex-1 sm:flex-initial"
                      onClick={() => void quickStartFromUrl()}
                      disabled={!busy && !url.trim()}
                      aria-disabled={busy}
                    >
                      {quickStage ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Play size={15} strokeWidth={1.75} aria-hidden />}
                      {quickStage === "fetch"
                        ? "Reading website…"
                        : quickStage === "generate"
                          ? "Building buyer…"
                          : quickStage === "save"
                            ? "Opening call…"
                            : "Build & start call"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost flex-1 sm:flex-initial"
                      onClick={() => void importUrl()}
                      disabled={!busy && !url.trim()}
                      aria-disabled={busy}
                    >
                      {fetching ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Sparkles size={15} strokeWidth={1.75} aria-hidden />}
                      {fetching ? "Importing…" : fetched ? "Re-import & customize" : "Import & customize"}
                    </button>
                  </div>
                </div>
                {fetched && !quickStage && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ok/35 bg-ok-soft/40 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[11px] font-medium text-ok">
                        Imported {fetched.title || fetched.url} · {(fetched.bytes / 1024).toFixed(0)} KB
                        {fetched.source === "web_search"
                          ? " · via web search"
                          : fetched.source === "direct+web_search"
                            ? " · page + web search"
                            : fetched.source === "firecrawl"
                              ? " · via Firecrawl"
                              : ""}
                        {" · public pages only, private addresses are blocked"}
                      </p>
                      <p className="mt-1 text-xs text-ink-soft">
                        Offer and sales job are filled in below. Press Build &amp; start call now, tweak any field below, or add CRM notes and ICP on the next step.
                      </p>
                    </div>
                    <button type="button" className="btn-quiet btn-sm shrink-0" onClick={() => setStep(1)}>
                      Add more context <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Or customize your buyer first (optional)</span>
                <span className="h-px flex-1 bg-line" />
              </div>

              <div>
                <p className="label">Sales job</p>
                <div className="flex flex-wrap gap-1.5">
                  {JOB_FAMILIES.map((f) => (
                    <button key={f.id} type="button" aria-pressed={input.role === f.id} onClick={() => { setRolePicked(true); setInput({ ...input, role: f.id }); }}
                      className={`chip ${input.role === f.id ? "!border-primary bg-primary-soft !text-ink" : "hover:border-ink-muted"}`}>{f.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <p className="label">Call type</p>
                <div className="flex flex-wrap gap-1.5">
                  {CALL_TYPES.map((c) => (
                    <button key={c} type="button" aria-pressed={input.callType === c} onClick={() => { setCallTypePicked(true); setInput({ ...input, callType: c as CallType }); }}
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
          {step === 0 && quickStage && <QuickBuildProgress stage={quickStage} targetUrl={url} />}

          {step === 1 && (
            <section className="card space-y-4">
              <p className="text-sm text-ink-soft">Add one or more sources. The wizard grounds the persona in them and shows which source each field came from.</p>
              <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Context sources" onKeyDown={radioKeys(CONTEXT_KINDS, tab, setTab)}>
                {CONTEXT_KINDS.map((k) => (
                  <button key={k} id={`ctx-tab-${k}`} type="button" role="tab" aria-selected={tab === k} aria-controls="ctx-panel" tabIndex={tab === k ? 0 : -1} onClick={() => setTab(k)}
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-primary text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}>
                    {contexts[k].trim() && <Check size={13} strokeWidth={1.75} className="text-ok" aria-hidden />}{CONTEXT_LABELS[k]}{contexts[k].trim() && <span className="sr-only"> (added)</span>}
                  </button>
                ))}
              </div>
              <div id="ctx-panel" role="tabpanel" aria-labelledby={`ctx-tab-${tab}`} className="space-y-4">
                {tab === "url" && (
                  <div className="flex gap-2">
                    <label className="relative flex-1">
                      <span className="sr-only">Product page URL</span>
                      <Globe size={15} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
                      <input className="input !pl-9" type="url" placeholder="https://example.com/pricing" value={url} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    {/* aria-disabled while busy, so the focused button keeps focus instead of dropping it to the page. */}
                    <button type="button" className="btn-ghost" onClick={importUrl} disabled={!fetching && !url.trim()} aria-disabled={fetching}>{fetching ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : null} Import</button>
                  </div>
                )}
                {tab === "url" && fetched && <p className="font-mono text-[11px] text-ok">Imported {fetched.title || fetched.url} · {(fetched.bytes / 1024).toFixed(0)} KB · public pages only, private addresses are blocked</p>}
                <textarea aria-label={CONTEXT_LABELS[tab]} rows={10} className="input font-mono !text-[13px]" placeholder={PLACEHOLDERS[tab]} value={contexts[tab]} onChange={(e) => setContexts({ ...contexts, [tab]: e.target.value })} />
              </div>
              <fieldset className="rounded-panel border border-line bg-sunken/50 p-3.5">
                <legend className="label !mb-1 flex items-center gap-1.5"><Lock size={13} strokeWidth={1.75} className="text-ink-muted" aria-hidden /> Company and product names</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition ${input.keepRealNames !== false ? "border-primary bg-primary-soft/40 text-ink" : "border-line bg-surface text-ink-soft hover:border-ink-muted"}`}>
                    <input type="radio" name="keep-real-names" className="mt-1 accent-[rgb(var(--primary))]" checked={input.keepRealNames !== false} onChange={() => setInput({ ...input, keepRealNames: true })} />
                    <span>
                      <span className="block font-semibold text-ink">Keep real names and context</span>
                      <span className="mt-0.5 block text-xs text-ink-soft">Practice selling your actual product. Saved privately on your account.</span>
                    </span>
                  </label>
                  <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition ${input.keepRealNames === false ? "border-primary bg-primary-soft/40 text-ink" : "border-line bg-surface text-ink-soft hover:border-ink-muted"}`}>
                    <input type="radio" name="keep-real-names" className="mt-1 accent-[rgb(var(--primary))]" checked={input.keepRealNames === false} onChange={() => setInput({ ...input, keepRealNames: false })} />
                    <span>
                      <span className="block font-semibold text-ink">Anonymize names</span>
                      <span className="mt-0.5 block text-xs text-ink-soft">Replace real company and person names with fictional placeholders.</span>
                    </span>
                  </label>
                </div>
              </fieldset>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[11px] text-ink-muted">{contexts[tab].length.toLocaleString()} / 8,000 chars · {filled.length} source{filled.length === 1 ? "" : "s"} added</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-ghost" onClick={generate} disabled={!busy && !canNext} aria-disabled={busy}>{generating ? <><Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> Drafting persona…</> : <><Sparkles size={16} strokeWidth={1.75} aria-hidden /> Draft &amp; review</>}</button>
                  <button type="button" className="btn-primary" onClick={() => void quickStartFromContext()} disabled={!busy && !canNext} aria-disabled={busy}>
                    {quickStage ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Play size={16} strokeWidth={1.75} aria-hidden />}
                    {quickStage === "save" ? "Opening call…" : quickStage ? "Building buyer…" : "Build & start call"}
                  </button>
                </div>
              </div>
            </section>
          )}
          {step === 1 && quickStage && <QuickBuildProgress stage={quickStage} targetUrl={fetched?.url || url} />}
          {step === 1 && generating && !quickStage && <DraftingPreview sources={filled.length} role={input.role} />}

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
                <div className="rounded-panel border border-line bg-sunken/50 p-3.5 space-y-3">
                  <p className="label !mb-0">Voice casting and delivery</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label" htmlFor="d-voice">Voice</label>
                      <select id="d-voice" className="input" value={draft.aiPersona.liveVoice ?? "marin"} onChange={(e) => patchPersona({ liveVoice: e.target.value })}>
                        {LIVE_CAST_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="d-emo">Starting mood</label>
                      <input id="d-emo" className="input" maxLength={20} placeholder="e.g. guarded, hurried" value={draft.aiPersona.emotion ?? ""} onChange={(e) => patchPersona({ emotion: e.target.value || undefined })} />
                    </div>
                  </div>
                  <div>
                    <label className="label" htmlFor="d-deliv">Delivery notes</label>
                    <textarea id="d-deliv" rows={2} className="input !text-[13px]" maxLength={400} placeholder="Pace, tone, and how their voice shifts during the call" value={draft.aiPersona.liveDelivery ?? ""} onChange={(e) => patchPersona({ liveDelivery: e.target.value || undefined })} />
                  </div>
                </div>
                <div><FieldLabel htmlFor="d-goal" src={src("traineeGoal")}>Rep goal</FieldLabel><textarea id="d-goal" rows={2} className="input" value={draft.traineeGoal} onChange={(e) => patch({ traineeGoal: e.target.value })} /></div>
                <div><FieldLabel htmlFor="d-script" src={src("callScript")}>Talk track (one step per line)</FieldLabel><textarea id="d-script" rows={6} className="input" value={draft.callScript} onChange={(e) => patch({ callScript: e.target.value })} /></div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="label !mb-0">Objections</p>
                    <button className="btn-quiet btn-sm" disabled={draft.objections.length >= 8} onClick={() => patch({ objections: [...draft.objections, { type: "price", line: "", prepAnswer: "" }] })}><Plus size={13} strokeWidth={1.75} aria-hidden /> Objection</button>
                  </div>
                  <div className="space-y-2">
                    {draft.objections.map((o, i) => (
                      <div key={i} className="rounded-lg border border-line p-3">
                        <div className="flex items-center gap-2">
                          <select aria-label={`Objection ${i + 1} type`} className="input !w-auto !py-1.5" value={o.type} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, type: e.target.value as ObjectionType } : x)) })}>
                            {OBJECTION_TYPES.map((t) => <option key={t} value={t}>{OBJECTION_LABELS[t]}</option>)}
                          </select>
                          <SourceChip src={src(`objections.${i}`)} />
                          <button className="btn-quiet btn-sm ml-auto !px-2" aria-label={`Remove objection ${i + 1}`} onClick={() => patch({ objections: draft.objections.filter((_, j) => j !== i) })}><Trash2 size={14} strokeWidth={1.75} aria-hidden /></button>
                        </div>
                        <input aria-label={`Objection ${i + 1} line`} className="input mt-2" placeholder="What they say" value={o.line} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)) })} />
                        <input aria-label={`Objection ${i + 1} prep answer`} className="input mt-2" placeholder="A strong answer for the coach to suggest" value={o.prepAnswer} onChange={(e) => patch({ objections: draft.objections.map((x, j) => (j === i ? { ...x, prepAnswer: e.target.value } : x)) })} />
                      </div>
                    ))}
                  </div>
                </div>
              </section>
              <PackPreview draft={draft} valid={!!validation?.success} issues={issues} ai={out?.method === "llm"} />
            </div>
          )}

          {step === 3 && draft && (
            <section className="card space-y-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <p className="max-w-md text-sm text-ink-soft">Weights decide how much each criterion counts in the grade and in the live estimate.</p>
                <div className="text-right" role="status">
                  <p className="label !mb-0">Total</p>
                  <p className={`mono text-[34px] font-semibold leading-none ${total === 100 ? "text-ok" : "text-caution"}`}>{total}<span className="text-lg">%</span></p>
                </div>
              </div>
              {/* The whole rubric as one spectrum: each criterion's share in its Debrief color, against the 100% scale. */}
              <div className="relative h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
                <div className="absolute inset-y-0 left-0 flex gap-px" style={{ width: `${Math.min(100, total)}%` }}>
                  {draft.rubric.map((c, i) => <span key={c.id + i} className="h-full transition-[flex-grow] duration-300" style={{ flex: `${Math.max(Number(c.weight) || 0, 0.001)} 1 0%`, background: critHue(i) }} />)}
                </div>
              </div>
              {total !== 100 && (
                <div className="banner-warn flex flex-wrap items-center justify-between gap-2">
                  <p>Weights add up to {total}%. Adjust the sliders or auto-balance to 100%.</p>
                  <button className="btn-ghost btn-sm" onClick={balance}>Balance to 100%</button>
                </div>
              )}
              <ul className="space-y-3">
                {draft.rubric.map((c, i) => (
                  <li key={c.id + i} className="rounded-lg border border-line p-3">
                    <div className="flex items-center gap-3">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: critHue(i) }} aria-hidden />
                      <input aria-label={`Criterion ${i + 1} name`} className="input flex-1 !py-1.5 font-semibold" value={c.name} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
                      <span className="mono w-12 text-right text-sm font-semibold">{c.weight}%</span>
                      <button className="btn-quiet btn-sm !px-2" aria-label={`Remove criterion ${i + 1}`} disabled={draft.rubric.length <= 3} onClick={() => patch({ rubric: draft.rubric.filter((_, j) => j !== i) })}><Trash2 size={14} strokeWidth={1.75} aria-hidden /></button>
                    </div>
                    <input type="range" min={0} max={60} step={1} aria-label={`Criterion ${i + 1} weight`} className="mt-3 w-full accent-[rgb(var(--primary))]" value={c.weight} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, weight: Number(e.target.value) } : r)) })} />
                    <div className="tape mt-1" aria-hidden><span style={{ width: `${Math.min(100, Number(c.weight) || 0)}%`, background: critHue(i) }} /></div>
                    <input aria-label={`Criterion ${i + 1} description`} className="input mt-3 !text-[13px]" placeholder="What good looks like, in observable terms" value={c.description} onChange={(e) => patch({ rubric: draft.rubric.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)) })} />
                  </li>
                ))}
              </ul>
              <button className="btn-ghost btn-sm" disabled={draft.rubric.length >= 7} onClick={() => patch({ rubric: [...draft.rubric, { id: `c${draft.rubric.length + 1}-${Date.now().toString(36)}`, name: "New criterion", description: "", weight: 0 }] })}><Plus size={13} strokeWidth={1.75} aria-hidden /> Criterion</button>
            </section>
          )}

          {step === 4 && draft && (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <section className="card space-y-5">
                <div>
                  <h2 className="text-lg font-bold">{stored ? "Save to your account" : "Keep it private"}</h2>
                  <p className="mt-1 text-sm text-ink-soft">
                    {stored
                      ? "Saved privately on your account so you can practice from any device. Run a test call to check how the buyer behaves."
                      : "Saves to this browser\u2019s library under \u201cYour personas\u201d. Run a test call to check the persona behaves before you share it."}
                  </p>
                  {canShareWithOrg && (
                    <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-sunken/50 p-3 text-sm">
                      <input type="checkbox" className="mt-0.5 accent-[rgb(var(--primary))]" checked={sharedWithOrg} onChange={(e) => setSharedWithOrg(e.target.checked)} />
                      <span>
                        <span className="flex items-center gap-1.5 font-semibold text-ink"><Users size={14} strokeWidth={1.75} className="text-primary" aria-hidden /> Share with my team</span>
                        <span className="mt-0.5 block text-xs text-ink-soft">Lets everyone in your organization practice this persona and lets managers assign it.</span>
                      </span>
                    </label>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => void savePrivate(true)} disabled={saving || !validation?.success}>
                      {saving ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Play size={15} strokeWidth={1.75} aria-hidden />} Save and test call
                    </button>
                    <button className="btn-ghost" onClick={() => void savePrivate(false)} disabled={saving || !validation?.success}>
                      <Save size={15} strokeWidth={1.75} aria-hidden /> {saved ? "Saved" : "Save only"}
                    </button>
                  </div>
                  <div role="status" className="empty:hidden">
                    {saved && (
                      <div className="banner-ok mt-4 flex flex-wrap items-center justify-between gap-3">
                        <p className="flex items-center gap-2">
                          <Check size={16} strokeWidth={1.75} className="shrink-0 text-ok" aria-hidden />
                          {savedStorage === "database"
                            ? (canShareWithOrg && sharedWithOrg ? "Saved to your account and shared with your team." : "Saved privately to your account.")
                            : "Saved to Your personas in this browser."}
                        </p>
                        <span className="flex flex-wrap gap-2">
                          <Link href="/library" className="btn-ghost btn-sm"><Library size={14} strokeWidth={1.75} aria-hidden /> Open the Library</Link>
                          <Link href={`/trainer?scenario=${encodeURIComponent(draft.id)}`} className="btn-primary btn-sm"><Play size={13} strokeWidth={1.75} aria-hidden /> Practice it</Link>
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="border-t border-line pt-5">
                  <h2 className="text-lg font-bold">Contribute it as a pack</h2>
                  <p className="mt-1 text-sm text-ink-soft">Copy the pack file, add it to <span className="mono text-[13px]">src/lib/personas/{draft.role}.ts</span>, and open a pull request. It starts as a draft until a maintainer reviews it; CI checks it against the same schema.</p>
                  <button className="btn-ghost mt-3" onClick={copyPack}><Copy size={15} strokeWidth={1.75} aria-hidden /> {copied ? "Copied" : "Copy pack JSON"}</button>
                </div>
              </section>
              <PackPreview draft={{ ...draft, status: "draft" }} valid={!!validation?.success} issues={[]} ai={out?.method === "llm"} />
            </div>
          )}

          {step < 4 && (
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button type="button" className="btn-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> Back</button>
              {step === 1 ? null : (
                <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                  {/* Why Next is off on the review step, in plain words next to the button. */}
                  {step === 2 && issues.length > 0 && (
                    <div className="text-right text-sm" role="status">
                      <p className="font-semibold text-caution">Fix these to continue:</p>
                      <ul className="text-ink-soft">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
                    </div>
                  )}
                  {rubricReason && <p id="next-reason" className="text-right text-sm font-medium text-caution">{rubricReason}</p>}
                  {step === 2 && (
                    <button type="button" className="btn-ghost" onClick={() => void savePrivate(true)} disabled={busy || !validation?.success}>
                      {saving ? <Loader2 size={15} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <Play size={15} strokeWidth={1.75} aria-hidden />} Save &amp; start call
                    </button>
                  )}
                  <button type="button" className="btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext || busy} aria-describedby={rubricReason ? "next-reason" : undefined}>Next <ArrowRight size={15} strokeWidth={1.75} aria-hidden /></button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const DRAFT_STAGES = ["Reading your sources", "Persona and behavior", "Objections and prep answers", "Talk track", "Rubric and weights"] as const;

const QUICK_BUILD_STEPS: { id: "fetch" | "generate" | "save"; label: string }[] = [
  { id: "fetch", label: "Reading website" },
  { id: "generate", label: "Building buyer, objections, and rubric" },
  { id: "save", label: "Saving and opening your training call" },
];

/** Live Flight Deck progress panel for the 1-URL quick-start pipeline. */
function QuickBuildProgress({ stage, targetUrl }: { stage: "fetch" | "generate" | "save"; targetUrl: string }) {
  const activeIdx = QUICK_BUILD_STEPS.findIndex((s) => s.id === stage);
  const host = (() => {
    try { return new URL(normalizeWizardUrl(targetUrl)).hostname; } catch { return targetUrl.trim() || "website"; }
  })();
  return (
    <section className="deck overflow-hidden rounded-panel border border-line" aria-label="Building training call">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <p className="truncate font-mono text-[11px] text-ink-soft">{host}</p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal"><span className="lamp lamp-signal !h-1.5 !w-1.5 motion-safe:animate-lamp-pulse" aria-hidden />preparing call</span>
      </div>
      <ol className="space-y-2.5 p-4">
        {QUICK_BUILD_STEPS.map((item, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <li key={item.id} className={`flex items-center gap-2.5 text-[13px] ${active ? "font-semibold text-ink" : done ? "text-ok" : "text-ink-muted"}`}>
              <span className={`lamp !h-1.5 !w-1.5 ${done ? "lamp-ok" : active ? "lamp-signal motion-safe:animate-lamp-pulse" : "lamp-off"}`} aria-hidden />
              <span>{i + 1}. {item.label}</span>
              {done && <span className="sr-only"> (done)</span>}
              {active && <span className="sr-only"> (in progress)</span>}
            </li>
          );
        })}
      </ol>
      <p role="status" className="border-t border-line px-3 py-2 font-mono text-[10px] text-ink-muted">
        Generating a realistic buyer, objections, and grading rubric. You can customize any field afterward.
      </p>
    </section>
  );
}

/** The pack preview while the persona is drafted: the same deck panel, with a pulsing signal lamp and placeholder lines. */
function DraftingPreview({ sources, role }: { sources: number; role: string }) {
  return (
    <section className="deck overflow-hidden rounded-panel border border-line" aria-label="Drafting persona">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <p className="truncate font-mono text-[11px] text-ink-soft">{role}-draft.json</p>
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal"><span className="lamp lamp-signal !h-1.5 !w-1.5 motion-safe:animate-lamp-pulse" aria-hidden />drafting</span>
      </div>
      <div className="grid gap-5 p-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
        <ol className="space-y-2.5">
          {DRAFT_STAGES.map((stage, i) => (
            <li key={stage} className="flex items-center gap-2.5 text-[13px] text-ink-soft">
              <span className={`lamp ${i === 0 ? "lamp-signal motion-safe:animate-lamp-pulse" : "lamp-off"} !h-1.5 !w-1.5`} aria-hidden />
              {i === 0 ? `${stage} (${sources})` : stage}
            </li>
          ))}
        </ol>
        <div className="space-y-2" aria-hidden>
          {[92, 64, 78, 40, 86, 58, 70].map((w, i) => <div key={i} className="skeleton h-2.5" style={{ width: `${w}%` }} />)}
        </div>
      </div>
      <p role="status" className="border-t border-line px-3 py-2 font-mono text-[10px] text-ink-muted">Drafting persona, objections and rubric. This takes a few seconds.</p>
    </section>
  );
}

function PackPreview({ draft, valid, issues, ai }: { draft: Scenario; valid: boolean; issues: string[]; ai?: boolean }) {
  return (
    <aside className="deck min-w-0 self-start overflow-hidden rounded-panel border border-line xl:sticky xl:top-[calc(var(--header-h,3.5rem)+1rem)]">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <p className="truncate font-mono text-[11px] text-ink-soft">{draft.id}.json</p>
        <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] ${valid ? "text-ok" : "text-caution"}`}><span className={`lamp ${valid ? "lamp-ok" : "lamp-caution"} !h-1.5 !w-1.5`} aria-hidden />{valid ? "schema valid" : "needs fixes"}</span>
      </div>
      {issues.length > 0 && <ul className="border-b border-line bg-caution-soft px-3 py-2 font-mono text-[11px] text-ink">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      <pre className="scroll-thin max-h-[70vh] overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink-soft">{packJson(draft)}</pre>
      {ai && <p className="border-t border-line px-3 py-2 font-mono text-[10px] text-ink-muted">Generated with AI · structured JSON, checked with zod</p>}
    </aside>
  );
}

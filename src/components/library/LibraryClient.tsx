"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, FileJson, Play, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import {
  CALL_TYPE_LABELS, JOB_FAMILIES, OBJECTION_LABELS, jobFamilyLabel, talkTrackSteps,
  type CallType, type ObjectionType, type Scenario,
} from "@/lib/scenarios";
import { duplicateScenario, listScenarios } from "@/lib/scenarioStore";
import { useAuth } from "@/contexts/AuthContext";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import Sheet from "@/components/ui/Sheet";
import { PageSkeleton } from "@/components/ui/Skeleton";

type Source = "built-in" | "draft" | "mine";
interface Filters { role: Set<string>; industry: Set<string>; difficulty: Set<string>; objection: Set<string>; callType: Set<string>; source: Set<string> }
const EMPTY: Filters = { role: new Set(), industry: new Set(), difficulty: new Set(), objection: new Set(), callType: new Set(), source: new Set() };

const sourceOf = (s: Scenario): Source => (!s.builtIn ? "mine" : s.status === "draft" ? "draft" : "built-in");
const SOURCE_LABEL: Record<Source, string> = { "built-in": "Reviewed", draft: "Draft (needs review)", mine: "Mine" };

/** Pack file contents as contributors would submit them (no runtime-only flags). */
export function packJson(s: Scenario) {
  const { builtIn, ...rest } = s;
  void builtIn;
  return JSON.stringify(rest, null, 2);
}

function matches(s: Scenario, f: Filters, q: string, skip?: keyof Filters) {
  const has = (k: keyof Filters, v: string | string[]) => k === skip || f[k].size === 0 || (Array.isArray(v) ? v.some((x) => f[k].has(x)) : f[k].has(v));
  if (!has("role", s.role) || !has("industry", s.industry) || !has("difficulty", s.difficulty) || !has("callType", s.callType) || !has("source", sourceOf(s))) return false;
  if (!has("objection", s.objections.map((o) => o.type))) return false;
  if (!q) return true;
  const hay = `${s.title} ${s.industry} ${s.aiPersona.name} ${s.aiPersona.role} ${jobFamilyLabel(s.role)} ${s.objections.map((o) => o.line).join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

export default function LibraryClient() {
  const { capabilities, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [all, setAll] = useState<Scenario[] | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Scenario | null>(null);
  const [showFacets, setShowFacets] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => setAll(listScenarios()), []);
  useEffect(() => {
    if (!isLoading && capabilities && !isAuthenticated) router.replace("/login");
  }, [isLoading, capabilities, isAuthenticated, router]);
  // "/" focuses search. Ctrl/Cmd+K belongs to the global command palette, so it is not bound here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !document.querySelector("[aria-modal='true']")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => (all ?? []).filter((s) => matches(s, filters, q)), [all, filters, q]);
  const filtering = q.trim() !== "" || Object.values(filters).some((v) => v.size > 0);

  /** Facet values with live counts (each facet counted with the other facets applied). */
  const facets = useMemo(() => {
    const list = all ?? [];
    const count = (key: keyof Filters, valuesOf: (s: Scenario) => string[]) => {
      const m = new Map<string, number>();
      for (const s of list) if (matches(s, filters, q, key)) for (const v of new Set(valuesOf(s))) m.set(v, (m.get(v) ?? 0) + 1);
      return m;
    };
    return {
      role: count("role", (s) => [s.role]),
      industry: count("industry", (s) => [s.industry]),
      difficulty: count("difficulty", (s) => [s.difficulty]),
      objection: count("objection", (s) => s.objections.map((o) => o.type)),
      callType: count("callType", (s) => [s.callType]),
      source: count("source", (s) => [sourceOf(s)]),
    };
  }, [all, filters, q]);

  function toggle(key: keyof Filters, value: string) {
    setFilters((f) => {
      const next = new Set(f[key]);
      if (next.has(value)) next.delete(value); else next.add(value);
      return { ...f, [key]: next };
    });
  }

  function duplicateAndEdit(s: Scenario) {
    const copy = duplicateScenario(s);
    router.push(`/trainer/scenarios?id=${encodeURIComponent(copy.id)}`);
  }

  if (!all || !capabilities) return <PageSkeleton rows={3} />;

  const families = [...JOB_FAMILIES.map((f) => f.id), ...new Set(all.map((s) => s.role).filter((r) => !JOB_FAMILIES.some((f) => f.id === r)))];
  const mine = all.filter((s) => !s.builtIn);
  const featured = all.filter((s) => s.builtIn && s.status === "reviewed");
  const familyCount = new Set(all.map((s) => s.role)).size;

  const facetRail = (
    <div className="space-y-6">
      <FacetGroup title="Role" values={families.filter((r) => facets.role.has(r) || filters.role.has(r)).map((r) => [r, jobFamilyLabel(r)])} counts={facets.role} selected={filters.role} onToggle={(v) => toggle("role", v)} limit={8} />
      <FacetGroup title="Objection type" values={Object.entries(OBJECTION_LABELS)} counts={facets.objection} selected={filters.objection} onToggle={(v) => toggle("objection", v)} chips />
      <FacetGroup title="Difficulty" values={[["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]]} counts={facets.difficulty} selected={filters.difficulty} onToggle={(v) => toggle("difficulty", v)} chips />
      <FacetGroup title="Call type" values={Object.entries(CALL_TYPE_LABELS).filter(([k]) => facets.callType.has(k) || filters.callType.has(k))} counts={facets.callType} selected={filters.callType} onToggle={(v) => toggle("callType", v)} chips />
      <FacetGroup title="Industry" values={[...facets.industry.keys()].sort().map((i) => [i, i])} counts={facets.industry} selected={filters.industry} onToggle={(v) => toggle("industry", v)} limit={6} />
      <FacetGroup title="Pack source" values={Object.entries(SOURCE_LABEL)} counts={facets.source} selected={filters.source} onToggle={(v) => toggle("source", v)} />
    </div>
  );

  /** Shelves swipe sideways on phones so 18 job families don't become one endless column; grids from sm up. */
  const grid = (items: Scenario[], withCreate = false, shelf = false) => (
    <div className={shelf
      ? "-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 scroll-thin sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-3 [&>*]:w-[84%] [&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:w-auto"
      : "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"}>
      {withCreate && <CreateTile />}
      {items.map((s) => <PersonaCard key={s.id} s={s} onOpen={() => setOpen(s)} onDuplicate={() => duplicateAndEdit(s)} />)}
    </div>
  );

  return (
    <div className="page enter">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Persona library</p>
          <h1 className="mt-1 text-3xl font-bold sm:text-4xl">Library</h1>
          <p className="mt-1 text-sm text-ink-muted"><span className="mono">{all.length}</span> personas across <span className="mono">{familyCount}</span> sales jobs · open source, add your own as a pack file</p>
        </div>
        <Link href="/library/new" className="btn-primary"><Sparkles size={16} aria-hidden /> New persona with AI</Link>
      </div>

      <div className="mt-6 flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Search personas</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
          <input ref={searchRef} className="input !pl-9 !pr-12" placeholder="Search personas, objections, industries" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="kbd absolute right-3 top-1/2 -translate-y-1/2" aria-hidden>/</span>
        </label>
        <button className="btn-ghost lg:hidden" onClick={() => setShowFacets(true)} aria-label="Filters"><SlidersHorizontal size={16} aria-hidden /><span className="hidden sm:inline">Filters</span></button>
      </div>
      {/* Always mounted so the first keystroke is announced; only the count is live, never the grid. */}
      <p role="status" aria-live="polite" className="sr-only">{filtering ? `${results.length} ${results.length === 1 ? "persona matches" : "personas match"}` : ""}</p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="Filters">
          <div className="sticky top-[calc(var(--header-h,3.5rem)+1rem)] max-h-[calc(100vh-var(--header-h,3.5rem)-2rem)] overflow-y-auto pr-2 scroll-thin">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Filters</h2>
              {filtering && <button className="text-xs font-semibold text-primary hover:underline" onClick={() => { setFilters(EMPTY); setQ(""); }}>Clear all</button>}
            </div>
            {facetRail}
          </div>
        </aside>

        <div className="min-w-0 space-y-10">
          {filtering ? (
            <section aria-label="Search results">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <p className="text-sm text-ink-soft"><span className="mono font-semibold text-ink">{results.length}</span> {results.length === 1 ? "persona" : "personas"}</p>
                {Object.entries(filters).flatMap(([k, set]) => [...(set as Set<string>)].map((v) => (
                  <button key={`${k}:${v}`} className="chip hover:border-ink-muted" onClick={() => toggle(k as keyof Filters, v)}>
                    {k === "role" ? jobFamilyLabel(v) : k === "objection" ? OBJECTION_LABELS[v as ObjectionType] : k === "callType" ? CALL_TYPE_LABELS[v as CallType] : k === "source" ? SOURCE_LABEL[v as Source] : v}
                    <X size={12} aria-label="Remove filter" />
                  </button>
                )))}
              </div>
              {results.length ? grid(results) : (
                <div className="card text-center">
                  <h2 className="text-base font-semibold">No persona matches yet</h2>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">Clear a filter, or have the wizard build this persona from a job description, product page or CRM notes.</p>
                  <Link href="/library/new" className="btn-primary mt-4"><Sparkles size={16} aria-hidden /> Build it with AI</Link>
                </div>
              )}
            </section>
          ) : (
            <>
              {mine.length > 0 && (
                <section aria-labelledby="sec-mine">
                  <SectionHead id="sec-mine" title="Your personas" count={mine.length} />
                  {grid(mine)}
                </section>
              )}
              <section aria-labelledby="sec-start">
                <SectionHead id="sec-start" title="Start here" count={featured.length} note="Reviewed scenarios with tuned rubrics" />
                {grid(featured, true, true)}
              </section>
              {families.map((fam) => {
                const items = all.filter((s) => s.builtIn && s.role === fam && !(s.status === "reviewed" && featured.includes(s)));
                if (!items.length) return null;
                const isOpen = expanded.has(fam);
                return (
                  <section key={fam} aria-labelledby={`sec-${fam}`}>
                    <SectionHead id={`sec-${fam}`} title={jobFamilyLabel(fam)} count={items.length}
                      action={items.length > 3 ? <button className="text-sm font-semibold text-primary hover:underline" onClick={() => setExpanded((e) => { const n = new Set(e); if (n.has(fam)) n.delete(fam); else n.add(fam); return n; })}>{isOpen ? "Show fewer" : `View all ${items.length}`}</button> : undefined} />
                    {grid(isOpen ? items : items.slice(0, 3), false, true)}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>

      {showFacets && (
        <Sheet title="Filters" onClose={() => setShowFacets(false)}
          footer={<div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setFilters(EMPTY)}>Clear all</button><button className="btn-primary flex-1" onClick={() => setShowFacets(false)}>Show {results.length}</button></div>}>
          {facetRail}
        </Sheet>
      )}
      {open && <PersonaSheet s={open} onClose={() => setOpen(null)} onDuplicate={() => duplicateAndEdit(open)} />}
    </div>
  );
}

function SectionHead({ id, title, count, note, action }: { id: string; title: string; count: number; note?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id={id} className="text-lg font-bold">{title} <span className="mono ml-1 text-sm font-medium text-ink-muted">{count}</span>{note && <span className="ml-2 text-xs font-normal text-ink-muted">{note}</span>}</h2>
      {action}
    </div>
  );
}

function FacetGroup({ title, values, counts, selected, onToggle, chips = false, limit }: {
  title: string; values: [string, string][]; counts: Map<string, number>; selected: Set<string>; onToggle: (v: string) => void; chips?: boolean; limit?: number;
}) {
  const [more, setMore] = useState(false);
  const shown = limit && !more ? values.slice(0, limit) : values;
  if (!values.length) return null;
  return (
    <fieldset>
      <legend className="label">{title}</legend>
      {chips ? (
        <div className="flex flex-wrap gap-1.5">
          {shown.map(([v, label]) => {
            const on = selected.has(v);
            const n = counts.get(v) ?? 0;
            return (
              <button key={v} type="button" aria-pressed={on} disabled={!n && !on} onClick={() => onToggle(v)}
                className={`chip transition-colors disabled:opacity-40 ${on ? "!border-primary bg-primary-soft !text-ink" : "hover:border-ink-muted/60"}`}>
                {label} <span className="mono text-[10px] text-ink-muted">{n}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <ul className="space-y-0.5">
          {shown.map(([v, label]) => {
            const n = counts.get(v) ?? 0;
            return (
              <li key={v}>
                <label className={`flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-sunken ${!n && !selected.has(v) ? "opacity-40" : ""}`}>
                  <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--primary))]" checked={selected.has(v)} onChange={() => onToggle(v)} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="mono text-[11px] text-ink-muted">{n}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {limit && values.length > limit && (
        <button type="button" className="mt-1 px-1.5 text-xs font-semibold text-primary hover:underline" onClick={() => setMore(!more)}>{more ? "Show fewer" : `Show ${values.length - limit} more`}</button>
      )}
    </fieldset>
  );
}

function CreateTile() {
  return (
    <Link href="/library/new" className="group flex min-h-[188px] flex-col justify-between rounded-panel border border-dashed border-primary/50 bg-primary-soft/40 p-4 transition hover:border-primary hover:bg-primary-soft/70">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-on"><Sparkles size={18} aria-hidden /></span>
      <span>
        <span className="block font-heading text-base font-bold">Create with AI</span>
        <span className="mt-1 block text-sm text-ink-soft">Paste a job description, product page, CRM notes or a call. The wizard drafts the persona, objections and rubric.</span>
      </span>
    </Link>
  );
}

function PersonaCard({ s, onOpen, onDuplicate }: { s: Scenario; onOpen: () => void; onDuplicate: () => void }) {
  const src = sourceOf(s);
  return (
    <article className="group relative flex min-h-[188px] flex-col rounded-panel border border-line bg-surface p-4 shadow-card transition hover:border-ink-muted/40 hover:shadow-pop">
      <button className="absolute inset-0 z-0 rounded-panel" onClick={onOpen} aria-label={`Open ${s.aiPersona.name}: ${s.title}, ${s.difficulty} difficulty`} />
      <div className="pointer-events-none relative flex items-start gap-3">
        <PersonaAvatar scenario={s} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-heading text-[15px] font-bold">{s.aiPersona.name}</h3>
            <DifficultyBars level={s.difficulty} showLabel={false} />
          </div>
          <p className="line-clamp-2 text-[13px] leading-snug text-ink-soft">{s.title}</p>
        </div>
      </div>
      <div className="pointer-events-none relative mt-3 flex flex-wrap gap-1.5">
        {s.objections.slice(0, 3).map((o, i) => <span key={i} className="chip !px-2 !text-[11px]">{OBJECTION_LABELS[o.type]}</span>)}
        {src !== "built-in" && <span className={`chip !px-2 !text-[11px] ${src === "mine" ? "!border-primary/50 !text-primary" : "!border-caution/40 !text-caution"}`}>{src === "mine" ? "Mine" : "Draft"}</span>}
      </div>
      <div className="relative mt-auto flex items-center justify-between gap-2 pt-4">
        <span className="pointer-events-none truncate font-mono text-[11px] text-ink-muted">{s.industry || "General"} · {s.durationMin} min</span>
        <span className="flex shrink-0 items-center gap-1">
          <button className="btn-quiet btn-sm !px-2" onClick={onDuplicate} title="Duplicate and edit" aria-label={`Duplicate and edit ${s.title}`}><Copy size={14} aria-hidden /></button>
          <Link href={`/trainer?scenario=${encodeURIComponent(s.id)}`} className="btn-primary btn-sm" aria-label={`Practise ${s.title}`}><Play size={13} aria-hidden /> Practise</Link>
        </span>
      </div>
    </article>
  );
}

function PersonaSheet({ s, onClose, onDuplicate }: { s: Scenario; onClose: () => void; onDuplicate: () => void }) {
  const [json, setJson] = useState(false);
  const [copied, setCopied] = useState(false);
  const steps = talkTrackSteps(s.callScript);
  async function copy() {
    try { await navigator.clipboard.writeText(packJson(s)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setJson(true); }
  }
  return (
    <Sheet title={s.aiPersona.name} subtitle={s.aiPersona.role} onClose={onClose} wide
      footer={
        <div className="flex flex-wrap gap-2">
          <Link href={`/trainer?scenario=${encodeURIComponent(s.id)}`} className="btn-primary flex-1" data-autofocus><Play size={16} aria-hidden /> Pre-flight</Link>
          <button className="btn-ghost" onClick={onDuplicate}><Copy size={16} aria-hidden /> Duplicate & edit</button>
          <button className="btn-ghost" onClick={() => setJson((v) => !v)} aria-pressed={json}><FileJson size={16} aria-hidden /> Pack file</button>
        </div>
      }>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <PersonaAvatar scenario={s} size={56} />
          <div className="min-w-0 space-y-1.5">
            <p className="font-heading text-base font-bold">{s.title}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip">{jobFamilyLabel(s.role)}</span>
              <span className="chip">{CALL_TYPE_LABELS[s.callType]}</span>
              <DifficultyBars level={s.difficulty} />
              <span className="font-mono text-[11px] text-ink-muted">{s.durationMin} min</span>
            </div>
          </div>
        </div>
        {s.status === "draft" && s.builtIn && <p className="banner-warn">Draft persona: it hasn&rsquo;t been reviewed by a maintainer yet. Spot something off? Duplicate it, fix it and send the pack file as a pull request.</p>}
        {json ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="label !mb-0">Pack file · <span className="normal-case">{s.id}.json</span></p>
              <button className="btn-quiet btn-sm" onClick={copy}>{copied ? "Copied" : "Copy JSON"}</button>
            </div>
            <pre className="scroll-thin max-h-[50vh] overflow-auto rounded-lg border border-line bg-sunken p-3 font-mono text-[11.5px] leading-relaxed">{packJson(s)}</pre>
          </div>
        ) : (
          <>
            <section><h3 className="label">Your goal</h3><p className="text-sm">{s.traineeGoal}</p></section>
            {s.objections.length > 0 && (
              <section>
                <h3 className="label">Expect these objections</h3>
                <ul className="space-y-2">
                  {s.objections.map((o, i) => (
                    <li key={i} className="rounded-lg border border-line p-3">
                      <span className="chip mb-1.5 !text-[11px]">{OBJECTION_LABELS[o.type]}</span>
                      <p className="text-sm font-medium">&ldquo;{o.line}&rdquo;</p>
                      {o.prepAnswer && <p className="mt-1 text-sm text-ink-soft"><span className="font-mono text-[11px] uppercase text-primary">Prep </span>{o.prepAnswer}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="label">Talk track</h3>
              <ol className="space-y-1.5">
                {steps.map((t, i) => <li key={i} className="flex gap-3 text-sm"><span className="mono mt-px w-5 shrink-0 text-ink-muted">{String(i + 1).padStart(2, "0")}</span>{t}</li>)}
              </ol>
            </section>
            <section>
              <h3 className="label">Rubric</h3>
              <ul className="space-y-1.5">
                {s.rubric.map((c) => <li key={c.id} className="flex justify-between gap-3 text-sm"><span>{c.name}</span><span className="mono text-ink-muted">{Math.round(c.weight)}%</span></li>)}
              </ul>
            </section>
          </>
        )}
      </div>
    </Sheet>
  );
}

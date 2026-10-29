"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BarChart3, CornerDownLeft, Cpu, LibraryBig, LogIn, Monitor, PhoneCall, RotateCcw, Search, SearchX,
  ShieldCheck, Sparkles, SunMoon, UserPlus, Users, type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { jobFamilyLabel, type Scenario } from "@/lib/scenarios";
import { canManageTeam } from "@/lib/team";
import { commandFields, createIndex, isPaletteShortcut, personaFields, search, toggledTheme, type ThemeChoice } from "@/lib/palette";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";

/** Same storage keys as ThemeToggle.tsx and TrainerClient.tsx. */
const THEME_KEY = "rtct.theme";
const LAST_SCENARIO = "rtct.lastScenario";
/** Dispatch on window to open the palette (the header button does). */
export const PALETTE_EVENT = "rtct:palette";
const PERSONA_LIMIT = 50;
const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

const inCall = () => document.documentElement.hasAttribute("data-incall");
const trainerHref = (id: string) => `/trainer?scenario=${encodeURIComponent(id)}`;

/** The persona library is ~300 KB of text, so it loads on first open instead of riding in every page's bundle. */
type Store = typeof import("@/lib/scenarioStore");
let store: Store | null = null;
const loadStore = () => import("@/lib/scenarioStore").then((m) => (store = m));

/** Mirrors ThemeToggle's apply logic exactly; the event lets other theme controls resync. */
function applyTheme(next: ThemeChoice) {
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent("rtct:theme", { detail: next }));
}

function readPrefs(): { theme: ThemeChoice; lastId: string | null; prefersDark: boolean } {
  let theme: ThemeChoice = "system", lastId: string | null = null;
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") theme = t;
    lastId = localStorage.getItem(LAST_SCENARIO);
  } catch {
    /* storage unavailable */
  }
  const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { theme, lastId, prefersDark };
}

/** With no query: your newest personas, then the reviewed starters. */
function suggested(all: Scenario[], skipId?: string): Scenario[] {
  const mine = all.filter((s) => !s.builtIn).reverse();
  const featured = all.filter((s) => s.builtIn && s.status === "reviewed");
  return [...mine, ...featured].filter((s) => s.id !== skipId).slice(0, 5);
}

interface Command { id: string; label: string; detail?: string; path?: string; keywords?: string; icon: LucideIcon; run: () => void }
type Row = { id: string; kind: "command"; command: Command } | { id: string; kind: "persona"; scenario: Scenario };
interface Section { key: string; title: string; count: string; rows: Row[]; start: number }

/** Mounted once in the root layout. Opens on Ctrl/Cmd+K or the rtct:palette event, never while a call is live. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    if (openRef.current || inCall()) return;
    const el = document.activeElement;
    openerRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    openRef.current = true;
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    const el = openerRef.current;
    openerRef.current = null;
    // Wait for the dialog to unmount so focus does not land on a removed node.
    if (el) requestAnimationFrame(() => { if (el.isConnected) el.focus({ preventScroll: true }); });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !isPaletteShortcut(e) || inCall()) return;
      e.preventDefault();
      if (openRef.current) hide();
      else show();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, show);
    };
  }, [show, hide]);

  return open ? <PaletteDialog onClose={hide} /> : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const { user, isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [prefs] = useState(readPrefs);
  const [scenarios, setScenarios] = useState<Scenario[] | null>(() => store?.listScenarios() ?? null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let alive = true;
    if (!store) loadStore().then((m) => { if (alive) setScenarios(m.listScenarios()); }).catch(() => { if (alive) setScenarios([]); });
    // On window so Esc still closes if focus ever slips out of the dialog.
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onEsc);
    return () => { alive = false; document.body.style.overflow = prev; window.removeEventListener("keydown", onEsc); };
  }, [onClose]);

  const go = useCallback((href: string) => {
    onClose();
    // TrainerClient watches the query string, so a client-side push also switches persona on /trainer.
    router.push(href);
  }, [onClose, router]);

  const last = useMemo(() => scenarios?.find((s) => s.id === prefs.lastId) ?? null, [scenarios, prefs.lastId]);
  const canSeeTeam = canManageTeam(user?.role, !!user?.isPlatformAdmin);

  const nav = useMemo<Command[]>(() => {
    const to = (id: string, label: string, path: string, icon: LucideIcon, keywords: string): Command => ({ id, label, path, icon, keywords, run: () => go(path) });
    if (!isAuthenticated) {
      return [
        to("login", "Sign in", "/login", LogIn, "log in account"),
        to("register", "Create account", "/register", UserPlus, "sign up get started register"),
      ];
    }
    return [
      to("library", "Library", "/library", LibraryBig, "personas browse catalog packs search"),
      to("new", "New persona with AI", "/library/new", Sparkles, "create build wizard generate add custom"),
      to("practice", "Practice", "/trainer", PhoneCall, "call train pre flight briefing start roleplay"),
      to("progress", "Progress", "/dashboard", BarChart3, "dashboard history scores sessions logbook stats"),
      ...(canSeeTeam ? [to("team", "Team", "/team", Users, "manager reps members invite coaching")] : []),
      to("models", "Models", "/settings/models", Cpu, "settings llm openai provider api key ai voice"),
      to("security", "Security", "/settings/security", ShieldCheck, "settings mfa two factor 2fa password account"),
    ];
  }, [isAuthenticated, canSeeTeam, go]);

  const actions = useMemo<Command[]>(() => {
    const next = toggledTheme(prefs.theme, prefs.prefersDark);
    const list: Command[] = [];
    if (last) {
      list.push({
        id: "resume", label: "Resume last persona", detail: `${last.aiPersona.name} · ${last.title}`, icon: RotateCcw,
        keywords: `continue again recent ${last.aiPersona.name}`, run: () => go(trainerHref(last.id)),
      });
    }
    list.push({
      id: "theme", label: "Toggle theme", detail: `Switch to ${next}`, icon: SunMoon,
      keywords: "dark light mode appearance color", run: () => { applyTheme(next); onClose(); },
    });
    if (prefs.theme !== "system") {
      list.push({
        id: "system-theme", label: "Match system theme", detail: "Follow your device setting", icon: Monitor,
        keywords: "auto device dark light mode appearance", run: () => { applyTheme("system"); onClose(); },
      });
    }
    return list;
  }, [prefs, last, go, onClose]);

  const navIndex = useMemo(() => createIndex(nav, commandFields), [nav]);
  const actionIndex = useMemo(() => createIndex(actions, commandFields), [actions]);
  const personaIndex = useMemo(() => createIndex(scenarios ?? [], personaFields), [scenarios]);

  const q = query.trim();
  const { sections, flat, total } = useMemo(() => {
    const goRanked = search(navIndex, q), actRanked = search(actionIndex, q);
    const goHits = goRanked.map((r) => r.item), actHits = actRanked.map((r) => r.item);
    let people: Scenario[] = [];
    let peopleCount = "";
    let peopleTotal = 0;
    let peopleTop = 0;
    if (scenarios) {
      if (q) {
        const hits = search(personaIndex, q);
        peopleTotal = hits.length;
        peopleTop = hits[0]?.score ?? 0;
        people = hits.slice(0, PERSONA_LIMIT).map((r) => r.item);
        peopleCount = hits.length > PERSONA_LIMIT ? `${PERSONA_LIMIT} of ${hits.length}` : String(hits.length);
      } else {
        people = suggested(scenarios, last?.id);
        peopleCount = `${people.length} of ${scenarios.length}`;
      }
    }
    const cmdRows = (prefix: string, list: Command[]): Row[] => list.map((c) => ({ id: `${prefix}:${c.id}`, kind: "command", command: c }));
    const raw: (Omit<Section, "start"> & { top: number })[] = [
      { key: "go", title: "Go to", count: String(goHits.length), rows: cmdRows("go", goHits), top: goRanked[0]?.score ?? 0 },
      { key: "personas", title: q ? "Personas" : "Suggested personas", count: peopleCount, rows: people.map((s) => ({ id: `persona:${s.id}`, kind: "persona", scenario: s })), top: peopleTop },
      { key: "actions", title: "Actions", count: String(actHits.length), rows: cmdRows("act", actHits), top: actRanked[0]?.score ?? 0 },
    ];
    // With a query, the section holding the best match goes first so Enter runs it; ties keep the order above.
    if (q) raw.sort((a, b) => b.top - a.top);
    const found = goHits.length + peopleTotal + actHits.length;
    // Nothing matched: offer the wizard as the one thing Enter can do.
    const shown = q && scenarios && !found
      ? [{ key: "build", title: "Suggestion", count: "", rows: cmdRows("go", [{ id: "build", label: "Build it with AI", detail: "Describe the buyer and the wizard drafts the persona, objections and rubric", icon: Sparkles, run: () => go("/library/new") }]) }]
      : raw.filter((s) => s.rows.length).map(({ top, ...s }) => { void top; return s; });
    let start = 0;
    const withStart: Section[] = shown.map((s) => { const sec = { ...s, start }; start += s.rows.length; return sec; });
    return { sections: withStart, flat: withStart.flatMap((s) => s.rows), total: found };
  }, [navIndex, actionIndex, personaIndex, scenarios, q, last, go]);

  const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;
  const empty = !!q && !!scenarios && total === 0;

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${uid}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [uid, activeIndex, q]);

  function run(row: Row | undefined) {
    if (!row) return;
    if (row.kind === "command") row.command.run();
    else go(trainerHref(row.scenario.id));
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      if (n) setActive(Math.max(0, Math.min(n - 1, activeIndex + (e.key === "PageDown" ? 5 : -5))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(flat[activeIndex]);
    }
  }

  /** Tab stays inside the dialog (Esc is handled on window above). */
  function onDialogKey(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items?.length) return;
    const first = items[0], lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastItem.focus(); }
    else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); first.focus(); }
  }

  const status = !q
    ? scenarios ? `${scenarios.length} personas · type to search` : "Loading personas"
    : !scenarios ? "Loading personas" : total ? `${total} ${total === 1 ? "result" : "results"}` : "No results";
  // The debrief is a deck page, so the palette follows it into the dark instrument theme.
  const deck = pathname.startsWith("/trainer/debrief");

  return createPortal(
    <div
      className={`fixed inset-0 z-[220] flex items-start justify-center bg-[rgb(var(--shadow)/0.45)] px-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-[2px] sm:px-6 sm:pt-[12vh] ${deck ? "deck" : ""}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKey}
        // Clicks on headings or padding would blur the input and strand the arrow keys; keep focus where typing happens.
        onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("input, button")) e.preventDefault(); }}
        className="flex max-h-[min(60dvh,520px)] w-full max-w-xl flex-col overflow-hidden rounded-sheet border border-line bg-surface text-ink shadow-pop animate-fade-up sm:max-h-[min(76vh,600px)]"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 transition-shadow focus-within:shadow-[inset_0_-2px_0_rgb(var(--primary))]">
          <Search size={18} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optId(activeIndex) : undefined}
            aria-label="Search personas, pages and actions"
            placeholder="Search personas, pages and actions"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-muted"
          />
          <button type="button" onClick={onClose} className="btn-quiet btn-sm shrink-0 !px-2" aria-label="Close command palette">
            <span className="sm:hidden">Cancel</span>
            <span className="kbd hidden sm:inline-flex" aria-hidden>Esc</span>
          </button>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {empty && (
            <div className="px-4 pb-3 pt-6 text-center">
              <SearchX size={22} strokeWidth={1.75} className="mx-auto text-ink-muted" aria-hidden />
              <p className="mt-2 text-sm font-semibold">Nothing matches &ldquo;{q}&rdquo;</p>
              <p className="mx-auto mt-1 max-w-xs text-sm text-ink-muted">Try fewer words, or have the wizard build this persona for you.</p>
            </div>
          )}
          <div id={listId} role="listbox" aria-label="Results">
            {sections.map((sec) => (
              <div key={sec.key} role="group" aria-labelledby={`${uid}-${sec.key}`} className="pb-1">
                <div id={`${uid}-${sec.key}`} aria-hidden className="flex items-baseline justify-between gap-2 px-2.5 pb-1 pt-2.5">
                  <span className="label !mb-0">{sec.title}</span>
                  {sec.count && <span className="mono text-[11px] text-ink-muted">{sec.count}</span>}
                </div>
                {sec.rows.map((row, j) => {
                  const i = sec.start + j;
                  const on = i === activeIndex;
                  return (
                    <div
                      key={row.id}
                      id={optId(i)}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => { if (!on) setActive(i); }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => run(row)}
                      className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors ${on ? "bg-primary-soft shadow-[inset_2px_0_0_rgb(var(--primary))]" : ""}`}
                    >
                      {row.kind === "persona" ? <PersonaRow s={row.scenario} /> : <CommandRow c={row.command} on={on} />}
                      <CornerDownLeft size={14} strokeWidth={1.75} className={`hidden shrink-0 text-primary sm:block ${on ? "" : "invisible"}`} aria-hidden />
                    </div>
                  );
                })}
              </div>
            ))}
            {!scenarios && (
              <div className="space-y-2 px-2.5 py-2" aria-hidden>
                <div className="skeleton h-9" />
                <div className="skeleton h-9" />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-sunken/60 px-4 py-2 font-mono text-[11px] text-ink-muted">
          <p role="status" aria-live="polite">{status}</p>
          <p className="hidden items-center gap-3 sm:flex" aria-hidden>
            <span className="flex items-center gap-1"><span className="kbd">↑</span><span className="kbd">↓</span> move</span>
            <span className="flex items-center gap-1"><span className="kbd">Enter</span> open</span>
            <span className="flex items-center gap-1"><span className="kbd">Esc</span> close</span>
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CommandRow({ c, on }: { c: Command; on: boolean }) {
  const Icon = c.icon;
  return (
    <>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${on ? "border-primary/40 bg-surface text-primary" : "border-line bg-sunken text-ink-soft"}`}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{c.label}</span>
        {c.detail && <span className="block truncate text-[12px] text-ink-muted">{c.detail}</span>}
      </span>
      {c.path && <span className="hidden shrink-0 font-mono text-[11px] text-ink-muted sm:inline">{c.path}</span>}
    </>
  );
}

function PersonaRow({ s }: { s: Scenario }) {
  const tag = !s.builtIn ? "Mine" : s.status === "draft" ? "Draft" : null;
  return (
    <>
      <PersonaAvatar scenario={s} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-ink">{s.aiPersona.name}</span>
          <DifficultyBars level={s.difficulty} />
        </span>
        <span className="block truncate text-[13px] text-ink-soft">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted">{jobFamilyLabel(s.role)}{tag ? ` · ${tag}` : ""}</span>
          {" · "}{s.title}
        </span>
      </span>
    </>
  );
}

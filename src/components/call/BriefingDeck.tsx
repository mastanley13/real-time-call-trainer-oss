"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  Eye,
  LayoutGrid,
  Layers,
  ListChecks,
  MessageSquareQuote,
  ShieldAlert,
  Sparkles,
  Target,
  UserCheck,
} from "lucide-react";
import type { CompetitionRoleCard } from "@/lib/competition";
import { OBJECTION_LABELS, type Scenario } from "@/lib/scenarios";

/** Categorical criterion hue (--cat-1 to --cat-8), matching the Library strip and Debrief. */
const critHue = (i: number) => `rgb(var(--cat-${(i % 8) + 1}))`;

type SlideId = "setup" | "goal" | "watchouts" | "plan";

interface SlideMeta {
  id: SlideId;
  shortLabel: string;
  title: string;
}

/**
 * Interactive slide-deck pre-call brief. Walks the rep through 4 short, plain-language cards
 * (Setup -> How you win -> Watch out for -> Game plan) with tap/swipe/keyboard controls instead
 * of a long vertical scroll, plus a 1-click "View all" toggle.
 */
export default function BriefingDeck({
  scenario,
  roleCard,
  steps,
  watchOuts,
  isCompetition,
  goalRead,
  onGoalReadChange,
}: {
  scenario: Scenario;
  roleCard: CompetitionRoleCard;
  steps: string[];
  watchOuts?: readonly string[];
  isCompetition: boolean;
  goalRead: boolean;
  onGoalReadChange: (read: boolean) => void;
}) {
  const buyerName = scenario.aiPersona.name;
  const hasWatchOuts = (watchOuts && watchOuts.length > 0) || scenario.objections.length > 0;
  const hasPlan = steps.length > 0;

  const slides: SlideMeta[] = [
    { id: "setup", shortLabel: "Setup", title: "What you are walking into" },
    { id: "goal", shortLabel: "How you win", title: "Your goal and grading" },
    ...(hasWatchOuts ? [{ id: "watchouts" as const, shortLabel: "Watch out", title: "Pushback to expect" }] : []),
    ...(hasPlan ? [{ id: "plan" as const, shortLabel: "Game plan", title: "Simple call flow" }] : []),
  ];

  const [index, setIndex] = useState(0);
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0]));
  const [viewAll, setViewAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const focusPrep = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);

  const totalWeight = scenario.rubric.reduce((a, c) => a + c.weight, 0) || 1;
  const safeIndex = Math.min(index, slides.length - 1);
  const current = slides[safeIndex];
  const progressPct = Math.round(((safeIndex + 1) / slides.length) * 100);

  function goTo(next: number) {
    const clamped = Math.max(0, Math.min(slides.length - 1, next));
    setIndex(clamped);
    setVisited((prev) => {
      const copy = new Set(prev);
      copy.add(clamped);
      return copy;
    });
    // Viewing the "How you win" card (or finishing the deck) automatically marks the Goal read lamp ready.
    if (slides[clamped]?.id === "goal" || clamped === slides.length - 1) {
      if (!goalRead) onGoalReadChange(true);
    }
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const delta = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(delta) < 48) return;
    if (delta < 0 && safeIndex < slides.length - 1) goTo(safeIndex + 1);
    if (delta > 0 && safeIndex > 0) goTo(safeIndex - 1);
  }

  function onDeckKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowRight" && safeIndex < slides.length - 1) {
      e.preventDefault();
      goTo(safeIndex + 1);
    } else if (e.key === "ArrowLeft" && safeIndex > 0) {
      e.preventDefault();
      goTo(safeIndex - 1);
    }
  }

  const renderSetup = () => (
    <div className="space-y-4">
      <dl className="grid gap-2.5 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-line bg-sunken/50 p-3.5">
          <dt className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            <UserCheck size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
            Who you are
          </dt>
          <dd className="mt-1 text-sm font-semibold leading-snug text-ink">{roleCard.yourRole}</dd>
        </div>

        <div className="min-w-0 rounded-lg border border-line bg-sunken/50 p-3.5">
          <dt className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            <Briefcase size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
            What you&rsquo;re pitching
          </dt>
          <dd className="mt-1 text-sm font-semibold leading-snug text-ink">{roleCard.pitching}</dd>
        </div>
      </dl>

      <div>
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">What&rsquo;s happening</p>
        <p className="mt-1.5 text-[15px] leading-relaxed text-ink">{roleCard.situation}</p>
      </div>

      {roleCard.openingLine && (
        <div className="rounded-lg border border-line border-l-2 border-l-primary bg-sunken/60 p-3.5">
          <p className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            <MessageSquareQuote size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
            {buyerName} will answer with
          </p>
          <p className="mt-1 text-[15px] font-medium italic leading-relaxed text-ink">&ldquo;{roleCard.openingLine}&rdquo;</p>
        </div>
      )}
    </div>
  );

  const renderGoal = () => (
    <div className="space-y-5">
      <div className="rounded-panel border border-l-4 border-primary/30 border-l-primary bg-primary-soft/40 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="label !mb-0 inline-flex items-center gap-1.5 !text-primary">
            <Target size={13} strokeWidth={1.75} aria-hidden />
            Your goal
          </p>
          <label className="-my-1 flex min-h-[36px] shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-ink-soft">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[rgb(var(--primary))]"
              checked={goalRead}
              onChange={(e) => onGoalReadChange(e.target.checked)}
            />
            Got it
          </label>
        </div>
        <p className="mt-2 font-heading text-lg font-semibold leading-snug text-ink">{scenario.traineeGoal}</p>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label !mb-0">What the AI grades you on</p>
          <span className="font-mono text-[11px] text-ink-muted">{scenario.rubric.length} areas</span>
        </div>
        <ul className="mt-2.5 divide-y divide-line">
          {scenario.rubric.map((c, i) => {
            const pct = Math.round((c.weight / totalWeight) * 100);
            const hue = critHue(i);
            return (
              <li key={c.id} className="py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hue }} aria-hidden />
                      {c.name}
                    </p>
                    {c.description && <p className="mt-0.5 pl-4 text-xs leading-relaxed text-ink-muted">{c.description}</p>}
                  </div>
                  <span className="mono shrink-0 text-xs font-semibold text-ink-soft">{pct}%</span>
                </div>
                <div className="tape ml-4 mt-1.5" aria-hidden>
                  <span style={{ width: `${pct}%`, background: hue }} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );

  const renderWatchOuts = () => (
    <div className="space-y-4">
      {watchOuts && watchOuts.length > 0 && (
        <div className="rounded-panel border border-caution/40 bg-caution-soft/50 p-4">
          <p className="label !mb-2 inline-flex items-center gap-1.5 text-ink">
            <AlertTriangle size={13} strokeWidth={1.75} className="text-caution" aria-hidden />
            Key tips for this call
          </p>
          <ul className="space-y-2">
            {watchOuts.map((w) => (
              <li key={w} className="flex gap-2.5 text-sm leading-relaxed text-ink">
                <span className="lamp lamp-caution mt-[0.45em] shrink-0" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scenario.objections.length > 0 && (
        <div>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
            <p className="label !mb-0">Pushback you may hear</p>
            <span className="text-xs text-ink-muted">
              {isCompetition ? "No live cues during official calls." : "Coach cues you live when one lands."}
            </span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {scenario.objections.map((o, i) => (
              <article key={i} className="rounded-panel border-l-2 border-alert/60 bg-sunken p-3.5 shadow-inner-top">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-alert" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">{OBJECTION_LABELS[o.type]}</p>
                    <p className="mt-0.5 text-sm font-semibold text-ink">&ldquo;{o.line}&rdquo;</p>
                  </div>
                </div>
                {o.prepAnswer && (revealed.has(i) ? (
                  <div
                    tabIndex={-1}
                    className="mt-2.5 rounded-md border border-dashed border-line bg-surface p-2.5 outline-none focus-visible:outline-2"
                    ref={(el) => { if (el && focusPrep.current === i) { focusPrep.current = null; el.focus(); } }}
                  >
                    <p className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">Strong reply</p>
                    <p className="mt-0.5 text-[13px] text-ink">{o.prepAnswer}</p>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn-quiet btn-sm mt-2 !min-h-[36px] !px-2 !text-primary"
                    onClick={() => { focusPrep.current = i; setRevealed((r) => new Set(r).add(i)); }}
                  >
                    <Eye size={14} strokeWidth={1.75} aria-hidden /> Think first, then show a strong reply
                  </button>
                ))}
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderPlan = () => (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="label !mb-0 inline-flex items-center gap-1.5">
          <ListChecks size={13} strokeWidth={1.75} className="text-primary" aria-hidden />
          Simple step-by-step flow
        </p>
        <span className="text-xs text-ink-muted">
          {isCompetition ? "Keep it natural, not scripted." : "Ticks live in your coach rail."}
        </span>
      </div>
      <ol className="relative space-y-2.5 pl-8 before:absolute before:bottom-2 before:left-[10px] before:top-2 before:w-px before:bg-line">
        {steps.map((s, i) => (
          <li key={i} className="relative text-sm leading-relaxed text-ink">
            <span className="absolute -left-8 top-0.5 flex h-[21px] w-[21px] items-center justify-center rounded-full border border-line bg-surface font-mono text-[10px] text-ink-muted">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2.5 rounded-lg border border-ok/35 bg-ok-soft/40 px-3.5 py-2.5 text-xs font-medium text-ink">
        <span className="lamp lamp-ok shrink-0" aria-hidden />
        <span>You&rsquo;re briefed and ready. Press Start call when you&rsquo;re set.</span>
      </div>
    </div>
  );

  const contentFor = (id: SlideId) => {
    if (id === "setup") return renderSetup();
    if (id === "goal") return renderGoal();
    if (id === "watchouts") return renderWatchOuts();
    return renderPlan();
  };

  if (viewAll) {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow inline-flex items-center gap-1.5 !text-ink">
            <Sparkles size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
            Full pre-call brief
          </p>
          <button type="button" className="btn-quiet btn-sm" onClick={() => setViewAll(false)}>
            <Layers size={14} strokeWidth={1.75} aria-hidden /> Switch to card deck
          </button>
        </div>
        {slides.map((s, i) => (
          <section key={s.id} className="card space-y-3" aria-labelledby={`all-slide-${s.id}`}>
            <div className="flex items-center justify-between gap-2">
              <h2 id={`all-slide-${s.id}`} className="font-heading text-base font-bold text-ink">
                <span className="mono mr-2 text-xs text-ink-muted">0{i + 1}</span>
                {s.title}
              </h2>
            </div>
            {contentFor(s.id)}
          </section>
        ))}
      </div>
    );
  }

  const nextSlide = slides[safeIndex + 1];

  return (
    <section
      aria-label="Pre-call briefing deck"
      onKeyDown={onDeckKeyDown}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="overflow-hidden rounded-sheet border border-line bg-surface shadow-card"
    >
      {/* Top progress tape */}
      <div className="h-1 w-full bg-sunken" aria-hidden>
        <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Deck header: step pills + Card/All toggle */}
      <div className="border-b border-line bg-sunken/60 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow inline-flex items-center gap-1.5 !text-ink">
            <Sparkles size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
            Quick brief · Card {safeIndex + 1} of {slides.length}
          </p>
          <button type="button" className="btn-quiet btn-sm !min-h-[30px] !px-2 text-xs" onClick={() => setViewAll(true)}>
            <LayoutGrid size={13} strokeWidth={1.75} aria-hidden /> View all
          </button>
        </div>

        <nav aria-label="Briefing cards" className="mt-2.5 flex flex-wrap gap-1.5">
          {slides.map((s, i) => {
            const active = i === safeIndex;
            const seen = visited.has(i) && !active;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active ? "step" : undefined}
                onClick={() => goTo(i)}
                className={`inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  active
                    ? "border-primary bg-primary-soft text-ink"
                    : seen
                      ? "border-line bg-surface text-ink-soft hover:border-ink-muted"
                      : "border-line bg-surface/60 text-ink-muted hover:text-ink"
                }`}
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded-full font-mono text-[10px] ${
                  active ? "bg-primary text-primary-on" : seen ? "bg-ok-soft text-ok" : "bg-sunken text-ink-muted"
                }`}>
                  {seen ? <Check size={10} strokeWidth={2.25} aria-hidden /> : i + 1}
                </span>
                <span>{s.shortLabel}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Active slide body */}
      <div className="p-4 sm:p-6">
        <h2 className="font-heading text-lg font-bold text-ink sm:text-xl">{current.title}</h2>
        <div className="mt-4">{contentFor(current.id)}</div>
      </div>

      {/* Deck navigation footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-sunken/40 px-4 py-3 sm:px-5">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => goTo(safeIndex - 1)}
          disabled={safeIndex === 0}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> Back
        </button>

        <span className="hidden font-mono text-[11px] text-ink-muted sm:inline">
          Swipe or use arrow keys
        </span>

        {nextSlide ? (
          <button type="button" className="btn-primary btn-sm" onClick={() => goTo(safeIndex + 1)}>
            Next: {nextSlide.shortLabel} <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
          </button>
        ) : (
          <button type="button" className="btn-ghost btn-sm" onClick={() => goTo(0)}>
            Review from start
          </button>
        )}
      </div>
    </section>
  );
}

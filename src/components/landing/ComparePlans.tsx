"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBilling } from "@/components/landing/BillingContext";
import type { Billing } from "@/lib/pricing";
import { NO_SCROLL_CUE, sameScrollCue, scrollCue, type ScrollCue } from "@/lib/scrollCue";

/** A cell is one string, or one string per billing period. */
export type CompareCell = string | { month: string; year: string };

export interface CompareRow {
  feature: string;
  self: string;
  free: string;
  pro: CompareCell;
  team: CompareCell;
}

export const cellText = (c: CompareCell, b: Billing): string => (typeof c === "string" ? c : c[b]);

/** Hint above the table. Renders nothing while the table fits. */
export function CompareHint({ cue }: { cue: ScrollCue }) {
  if (!cue.overflows) return null;
  return <p className="mt-4 text-xs text-ink-muted">Scroll for more plans</p>;
}

/**
 * The lamp drawn before a plain answer, as a pseudo-element so the cell's text stays exactly the answer.
 * Yes-type answers light green, No is an off lamp, anything else (a price, a note, a label) gets none.
 */
const LAMP_BASE = "before:mr-2 before:inline-block before:h-1.5 before:w-1.5 before:-translate-y-px before:rounded-full before:align-middle before:content-['']";
const YES = new Set(["Yes", "Unlimited", "Managed", "Automatic", "Full", "Enforced for team"]);
export function cellLamp(text: string): string {
  if (YES.has(text)) return `${LAMP_BASE} before:bg-ok`;
  if (text === "No") return `${LAMP_BASE} before:bg-ink-muted/50`;
  return "";
}

/** Width of the sticky feature column; the start fade sits just past it (left-36, sm:left-48). */
const FEATURE_COL = "w-36 min-w-[9rem] sm:w-48 sm:min-w-[12rem]";
const HEAD = "px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em]";

/** Edge fades on the sides that still have hidden columns. */
export function CompareFades({ cue }: { cue: ScrollCue }) {
  return (
    <>
      {cue.fadeStart && <div aria-hidden data-fade="start" className="pointer-events-none absolute inset-y-0 left-36 w-10 bg-gradient-to-r from-surface to-transparent sm:left-48" />}
      {cue.fadeEnd && <div aria-hidden data-fade="end" className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-panel bg-gradient-to-l from-surface to-transparent" />}
    </>
  );
}

export default function ComparePlans({ rows }: { rows: CompareRow[] }) {
  const { billing } = useBilling();
  const ref = useRef<HTMLDivElement>(null);
  const [cue, setCue] = useState<ScrollCue>(NO_SCROLL_CUE);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = scrollCue(el);
    setCue((prev) => (sameScrollCue(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [measure]);

  return (
    <>
      <CompareHint cue={cue} />
      <div className={`relative ${cue.overflows ? "mt-2" : "mt-6"}`}>
        <div ref={ref} role="region" aria-label="Compare plans" tabIndex={0}
          className="scroll-thin overflow-x-auto rounded-panel border border-line bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <table className="w-full min-w-[680px] border-separate border-spacing-0 text-left text-sm">
            <thead className="text-ink-muted">
              <tr>
                <th scope="col" className={`${HEAD} sticky left-0 z-10 border-r border-line bg-sunken ${FEATURE_COL}`}>Feature</th>
                <th scope="col" className={`${HEAD} bg-sunken`}>Self-host (MIT)</th>
                <th scope="col" className={`${HEAD} bg-sunken`}>Free</th>
                <th scope="col" className={`${HEAD} bg-sunken`}>Pro</th>
                <th scope="col" className={`${HEAD} bg-primary-soft/60 text-ink shadow-[inset_0_2px_0_rgb(var(--primary))]`}>Team</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cells = [r.self, r.free, cellText(r.pro, billing), cellText(r.team, billing)];
                return (
                  <tr key={r.feature} className="align-top">
                    <th scope="row" className={`sticky left-0 z-10 border-r border-t border-line bg-surface px-4 py-3 font-medium text-ink ${FEATURE_COL}`}>{r.feature}</th>
                    {cells.map((c, i) => (
                      <td key={i} className={`border-t border-line px-4 py-3 ${i === 3 ? "bg-primary-soft/25 text-ink" : "text-ink-soft"} ${cellLamp(c)}`}>{c}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <CompareFades cue={cue} />
      </div>
    </>
  );
}

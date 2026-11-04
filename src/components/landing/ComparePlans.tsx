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

/** Edge fades on the sides that still have hidden columns. */
export function CompareFades({ cue }: { cue: ScrollCue }) {
  return (
    <>
      {cue.fadeStart && <div aria-hidden data-fade="start" className="pointer-events-none absolute inset-y-0 left-0 w-10 rounded-l-panel bg-gradient-to-r from-surface to-transparent" />}
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
          className="overflow-x-auto rounded-panel border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-sunken text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Feature</th>
                <th scope="col" className="px-4 py-3 font-medium">Self-host (MIT)</th>
                <th scope="col" className="px-4 py-3 font-medium">Free</th>
                <th scope="col" className="px-4 py-3 font-medium">Pro</th>
                <th scope="col" className="px-4 py-3 font-medium">Team</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feature} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3 font-medium text-ink">{r.feature}</th>
                  <td className="px-4 py-3 text-ink-soft">{r.self}</td>
                  <td className="px-4 py-3 text-ink-soft">{r.free}</td>
                  <td className="px-4 py-3 text-ink-soft">{cellText(r.pro, billing)}</td>
                  <td className="px-4 py-3 text-ink-soft">{cellText(r.team, billing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CompareFades cue={cue} />
      </div>
    </>
  );
}

"use client";

import { useEffect } from "react";
import { BASELINE_LINE, ONBOARDING_STEPS } from "@/lib/onboarding";

/** First-run orientation. Non-modal, never takes focus on mount, and the parent decides when it renders. */
export default function GettingStarted({ welcome, onDismiss }: { welcome: string; onDismiss: () => void }) {
  // Escape closes it from anywhere on the page while it is open, unless something else (a dialog, the palette) already handled the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <section role="region" aria-labelledby="getting-started-h" className="card mb-6">
      <h2 id="getting-started-h" className="font-heading text-xl font-bold">Getting started</h2>
      <p className="mt-1 text-base font-medium">{welcome}</p>
      <ol role="list" className="mt-4 space-y-3">
        {ONBOARDING_STEPS.map((s, i) => (
          <li key={s.title} className="flex items-start gap-3">
            <span className="mono flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-sunken text-xs text-ink-muted" aria-hidden>{i + 1}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{s.title}</p>
              <p className="text-sm text-ink-soft">{s.help}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{BASELINE_LINE}</p>
        <button type="button" className="btn-primary min-h-[44px] min-w-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" onClick={onDismiss}>Got it</button>
      </div>
    </section>
  );
}

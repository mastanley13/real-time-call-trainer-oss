"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app-error]", error.digest ?? "unhandled");
  }, [error]);

  return (
    <div className="page py-16 sm:py-24">
      <div className="deck mx-auto max-w-xl overflow-hidden rounded-sheet border border-line p-6 shadow-pop sm:p-8" role="alert">
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.1em] text-alert">
          <span className="lamp lamp-alert" aria-hidden />
          <span>Unexpected error</span>
        </div>
        <div className="mt-5 flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-alert/40 bg-alert-soft text-alert">
            <AlertTriangle size={20} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold text-ink">Something interrupted this screen</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Try loading the view again. If this keeps happening, return to the home page and start fresh.
            </p>
          </div>
        </div>
        <div className="mt-7 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="btn-primary">
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden /> Try again
          </button>
          <Link href="/" className="btn-ghost">Go home</Link>
        </div>
      </div>
    </div>
  );
}

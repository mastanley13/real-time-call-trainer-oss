"use client";

import Link from "next/link";
import "./globals.css";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="deck flex min-h-dvh items-center justify-center p-6">
        <div className="panel max-w-md space-y-4 p-6 text-left shadow-pop" role="alert">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.1em] text-alert">
            <span className="lamp lamp-alert" aria-hidden /> Application error
          </p>
          <h1 className="font-heading text-xl font-bold text-ink">The app ran into an unexpected error</h1>
          <p className="text-sm leading-relaxed text-ink-soft">
            Reload this page to restore your session. No call audio is stored on our servers.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={reset} className="btn-primary">Try again</button>
            <Link href="/" className="btn-ghost">Go home</Link>
          </div>
        </div>
      </body>
    </html>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Linkedin, Share2 } from "lucide-react";

/** LinkedIn's share dialog for a URL. LinkedIn reads the title and image from the page's Open Graph tags. */
export function linkedInShareUrl(url: string): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
}

/** X's post composer, prefilled with the text and the card URL. */
export function xShareUrl(url: string, text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

/** Copy link, share on LinkedIn and share on X for a championship share card. */
export default function ShareCardActions({ url, text }: { url: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      timer.current = window.setTimeout(() => setState("idle"), 2000);
    } catch {
      // Clipboard access can be blocked (insecure origin, permissions). Show the link selected so it can be copied by hand.
      setState("failed");
      window.setTimeout(() => field.current?.select(), 0);
    }
  }

  return (
    <div className="w-full">
      <div className="grid gap-2 sm:grid-cols-3">
        <button type="button" className="btn-primary w-full" onClick={copy}>
          {state === "copied" ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
          {state === "copied" ? "Copied!" : "Copy card link"}
        </button>
        <a href={linkedInShareUrl(url)} target="_blank" rel="noopener noreferrer" className="btn-ghost w-full">
          <Linkedin size={16} strokeWidth={1.75} aria-hidden /> Share on LinkedIn<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <a href={xShareUrl(url, text)} target="_blank" rel="noopener noreferrer" className="btn-ghost w-full">
          <Share2 size={16} strokeWidth={1.75} aria-hidden /> Share on X<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{state === "copied" ? "Card link copied" : ""}</p>
      {state === "failed" && (
        <div className="mt-3">
          <label htmlFor="card-link" className="label">Copy this link</label>
          <input id="card-link" ref={field} className="input mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <p className="mt-1 text-xs text-ink-muted">Your browser blocked automatic copying. Select the link and copy it.</p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import LogoMark from "@/components/LogoMark";

/** What the right-hand pane reports. Facts only: each line is something the product does today. */
const CHECKS = [
  { lamp: "lamp-ok", name: "Live coach channel", note: "Cues land right after each turn." },
  { lamp: "lamp-ok", name: "Quote-backed debriefs", note: "Every score points to the line that earned it." },
  { lamp: "lamp-signal", name: "Voice and text practice", note: "Practice by text anywhere, or turn on live voice." },
] as const;

/**
 * The frame for every sign-in, sign-up and account-recovery page. Below `lg` it is the form alone; from `lg` up a dark
 * systems-check pane sits beside it. `compact` keeps the single form column at every width, for short transient screens.
 */
export default function AuthShell({ title, subtitle, children, compact = false }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-var(--header-h,56px))] items-center justify-center px-4 py-8 sm:py-12">
      <div className={`panel enter w-full overflow-hidden shadow-pop ${compact ? "max-w-md" : "max-w-md lg:grid lg:max-w-4xl lg:grid-cols-[minmax(0,1fr)_340px]"}`}>
        <div className={`p-5 sm:p-8 ${compact ? "" : "lg:p-10"}`}>
          <LogoMark size={36} />
          <h1 className="mt-5 text-2xl font-bold">{title}</h1>
          <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        {!compact && <SystemsCheck />}
      </div>
    </div>
  );
}

function SystemsCheck() {
  return (
    <aside aria-label="What you get" className="deck hidden flex-col justify-between gap-10 border-l border-line p-8 lg:flex">
      <div>
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-muted">Systems check</p>
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {CHECKS.map((c) => (
            <li key={c.name} className="flex items-start gap-3 py-4">
              <span className={`lamp ${c.lamp} mt-1.5`} aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{c.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{c.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="flex items-start gap-2.5 text-xs leading-relaxed text-ink-soft">
        <ShieldCheck size={16} strokeWidth={1.75} className="mt-px shrink-0 text-ok" aria-hidden />
        <span>Call audio is never recorded or stored. We do not sell personal data.</span>
      </p>
    </aside>
  );
}

/**
 * A password field with a show/hide toggle. The toggle is a pressed/not-pressed button with a fixed name, so a screen
 * reader hears "Show password, toggle button, pressed" rather than a label that flips under the user.
 */
export function PasswordInput({ toggleLabel = "Show password", className = "", ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { toggleLabel?: string }) {
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeOff : Eye;
  return (
    <div className="relative">
      <input {...props} type={shown ? "text" : "password"} className={`input pr-11 ${className}`} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={toggleLabel}
        aria-pressed={shown}
        aria-controls={props.id}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-ink-muted transition-colors hover:text-ink focus-visible:outline-offset-[-2px]"
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

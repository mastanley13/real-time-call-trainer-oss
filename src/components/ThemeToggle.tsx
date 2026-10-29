"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "system" | "light" | "dark";
const KEY = "rtct.theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Theme: match system", light: "Theme: light", dark: "Theme: dark" };

/** Cycles system → light → dark. The choice is applied as data-theme on <html> (see the inline script in layout.tsx). */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY);
      if (t === "light" || t === "dark") setTheme(t);
    } catch {
      /* storage unavailable */
    }
    // The command palette changes the theme too and announces it with this event.
    const onTheme = (e: Event) => {
      const d = (e as CustomEvent<unknown>).detail;
      if (d === "light" || d === "dark" || d === "system") setTheme(d);
    };
    window.addEventListener("rtct:theme", onTheme);
    return () => window.removeEventListener("rtct:theme", onTheme);
  }, []);

  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable */
    }
  }

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button type="button" onClick={cycle} className={`btn-quiet !min-h-[36px] !px-2.5 ${className}`} aria-label={LABEL[theme]} title={LABEL[theme]}>
      <Icon size={17} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** Right-hand sheet (bottom sheet on phones). Focus moves in and is trapped, Esc closes, focus returns to the opener. */
export default function Sheet({ title, subtitle, onClose, children, footer, wide = false }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    const opener = document.activeElement as HTMLElement | null;
    const auto = ref.current?.querySelector<HTMLElement>("[data-autofocus]");
    if (auto) auto.focus();
    else ref.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The opener may be gone by now (a removed row, a busy button that unmounted); fall back to the main region.
    return () => { document.body.style.overflow = prev; (opener?.isConnected ? opener : document.getElementById("main"))?.focus(); };
  }, [mounted]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end justify-end bg-[rgb(var(--shadow)/0.4)] sm:items-stretch" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`flex max-h-[88dvh] w-full flex-col rounded-t-sheet border border-line bg-surface text-ink shadow-pop outline-none animate-cue-in sm:max-h-none sm:rounded-none sm:rounded-l-sheet ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
          </div>
          <button className="btn-quiet !min-h-[36px] !px-2" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

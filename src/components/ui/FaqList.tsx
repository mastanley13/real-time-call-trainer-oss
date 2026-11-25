import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface FaqItem {
  q: string;
  /** Plain text, or inline content such as links. */
  a: ReactNode;
}

/** Accessible FAQ disclosure list with rotating chevron and 48px touch targets. Server-safe. */
export default function FaqList({ items, className = "" }: { items: readonly FaqItem[]; className?: string }) {
  return (
    <div className={`divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface ${className}`}>
      {items.map((f) => (
        <details key={f.q} className="group">
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 px-5 py-3.5 text-left font-medium text-ink transition-colors hover:bg-sunken/50 hover:text-primary marker:content-none [&::-webkit-details-marker]:hidden">
            <ChevronDown size={17} strokeWidth={1.75} className="order-last shrink-0 text-ink-muted transition-transform duration-150 group-open:rotate-180 group-open:text-primary" aria-hidden />
            <span>{f.q}</span>
          </summary>
          <p className="border-t border-line/60 bg-sunken/35 px-5 py-4 text-sm leading-relaxed text-ink-soft">{f.a}</p>
        </details>
      ))}
    </div>
  );
}

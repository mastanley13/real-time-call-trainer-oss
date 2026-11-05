import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LIBRARY } from "@/lib/personas";
import { CALL_TYPE_LABELS } from "@/lib/scenarios";

/** Branded tenants show their own first personas on the landing page instead of the stock water-heater call in HeroDeck. */
export default function PersonaPreview() {
  return (
    <div className="deck rounded-sheet border border-line p-5 shadow-pop">
      <p className="label">Ready to practise</p>
      <ul className="mt-3 space-y-2">
        {LIBRARY.slice(0, 4).map((s) => (
          <li key={s.id} className="rounded-panel border border-line bg-surface p-3">
            <p className="font-heading text-sm font-bold">{s.aiPersona.name}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">{s.title}</p>
            <p className="mt-1 font-mono text-[11px] text-ink-muted">{CALL_TYPE_LABELS[s.callType]} · {s.difficulty} · about {s.durationMin} min</p>
          </li>
        ))}
      </ul>
      {LIBRARY.length > 4 && (
        <Link href="/library" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-2 hover:underline">
          See all {LIBRARY.length} <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
        </Link>
      )}
    </div>
  );
}

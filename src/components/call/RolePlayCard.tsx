"use client";

import { Briefcase, MessageSquareQuote, Sparkles, UserCheck } from "lucide-react";
import type { CompetitionRoleCard } from "@/lib/competition";

/**
 * Modern role-play entry card shown before a call starts (on /compete BriefSheet and /trainer Briefing).
 * Gives the rep a 5-second snapshot: who you play, what you're pitching, the situation, and the buyer's opening line.
 */
export default function RolePlayCard({
  card,
  buyerName,
  compact = false,
}: {
  card: CompetitionRoleCard;
  buyerName: string;
  compact?: boolean;
}) {
  return (
    <section
      aria-label="Role-play card"
      className={`overflow-hidden rounded-panel border border-line bg-surface shadow-card ${compact ? "" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/70 px-4 py-2.5">
        <p className="eyebrow inline-flex items-center gap-1.5 !text-ink">
          <Sparkles size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
          Your role-play card
        </p>
        <span className="font-mono text-[11px] text-ink-muted">Quick setup before you dial</span>
      </div>

      <div className={compact ? "space-y-3 p-4" : "space-y-4 p-4 sm:p-5"}>
        <dl className={`grid gap-2.5 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>
          <div className="min-w-0 rounded-lg border border-line bg-sunken/50 p-3">
            <dt className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              <UserCheck size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
              Who you are
            </dt>
            <dd className="mt-1 text-sm font-semibold leading-snug text-ink">{card.yourRole}</dd>
          </div>

          <div className="min-w-0 rounded-lg border border-line bg-sunken/50 p-3">
            <dt className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              <Briefcase size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
              What you&rsquo;re pitching
            </dt>
            <dd className="mt-1 text-sm font-semibold leading-snug text-ink">{card.pitching}</dd>
          </div>
        </dl>

        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">What&rsquo;s happening</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-soft">{card.situation}</p>
        </div>

        {card.openingLine && (
          <div className="rounded-lg border border-line border-l-2 border-l-primary bg-sunken/60 p-3">
            <p className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              <MessageSquareQuote size={12} strokeWidth={1.75} className="text-primary" aria-hidden />
              {buyerName} will answer with
            </p>
            <p className="mt-1 text-sm font-medium italic leading-relaxed text-ink">&ldquo;{card.openingLine}&rdquo;</p>
          </div>
        )}
      </div>
    </section>
  );
}

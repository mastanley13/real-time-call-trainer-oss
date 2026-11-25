"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Share2, Trophy } from "lucide-react";
import {
  COMPETITION_MAX_ATTEMPTS,
  COMPETITION_PERIODS,
  COMPETITION_PERIOD_LABELS,
  COMPETITION_PRIZES,
  COMPETITION_TRACKS,
  type CompetitionLeaderboardRow,
  type CompetitionPeriod,
  type CompetitionStatusResponse,
} from "@/lib/competition";

type Slice = { rows: CompetitionLeaderboardRow[]; periodLabel: string; total: number };

function rankTone(rank: number): string {
  if (rank === 1) return "bg-primary text-primary-on";
  if (rank <= 3) return "bg-primary-soft text-primary";
  return "bg-sunken text-ink-muted";
}

/**
 * Live leaderboard draw for the home page. Hydrates from /api/competition so the home page stays static and fast,
 * while giving visitors an immediate competitive hook (Day / Week / Month / Year + Monthly Winner Prize).
 */
export default function LeaderboardSpotlight() {
  const [period, setPeriod] = useState<CompetitionPeriod>("month");
  const [slices, setSlices] = useState<Partial<Record<CompetitionPeriod, Slice>>>({});
  const [failed, setFailed] = useState(false);

  const slice = slices[period];

  useEffect(() => {
    if (slice) return;
    const ctl = new AbortController();
    setFailed(false);
    fetch(`/api/competition?period=${encodeURIComponent(period)}&limit=5`, { cache: "no-store", signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data: CompetitionStatusResponse) => {
        setSlices((prev) => ({
          ...prev,
          [period]: { rows: data.leaderboard.slice(0, 5), periodLabel: data.periodLabel, total: data.totalQualifiedEntries },
        }));
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted && !(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
      });
    return () => ctl.abort();
  }, [period, slice]);

  const topScore = slice?.rows[0]?.overallScore;

  return (
    <section aria-labelledby="lb-spot-h" className="desk-wrap">
      <div className="border-t border-line py-12 md:py-16">
        <div className="deck overflow-hidden rounded-sheet border border-line p-6 shadow-pop sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)] lg:items-center">
            <div className="min-w-0 space-y-4">
              <p className="eyebrow inline-flex items-center gap-2">
                <span className="lamp lamp-signal animate-lamp-pulse" aria-hidden />
                Live sales call leaderboard
              </p>
              <h2 id="lb-spot-h" className="font-heading text-2xl font-bold leading-tight text-ink sm:text-[32px]">
                {topScore ? `Think you can beat ${topScore} this month?` : "Think you can take #1 this month?"}
              </h2>
              <p className="max-w-[50ch] text-sm leading-6 text-ink-soft sm:text-base">
                {`Take ${COMPETITION_MAX_ATTEMPTS} free blind voice calls every month across ${COMPETITION_TRACKS.length} real sales tracks, including Car Dealerships, Insurance, Solar, and B2B SaaS. Monthly #1 wins ${COMPETITION_PRIZES.soloHeadline.toLowerCase()} ($${COMPETITION_PRIZES.soloValueUsd} value) plus a Team seat discount.`}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {COMPETITION_TRACKS.map((t) => (
                  <span key={t.slug} className="chip">{t.shortLabel}</span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link href="/compete" className="btn-primary desk-btn">
                  <Trophy size={16} strokeWidth={1.75} aria-hidden /> Enter the challenge <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
                </Link>
                <Link href="/compete#leaderboard" className="btn-ghost desk-btn">Full standings</Link>
              </div>
            </div>

            <div className="min-w-0 rounded-panel border border-line bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="segmented" role="group" aria-label="Leaderboard time window">
                  {COMPETITION_PERIODS.map((p) => {
                    const on = p === period;
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPeriod(p)}
                        className={`segmented-btn !px-2.5 !py-1 !text-xs whitespace-nowrap ${on ? "bg-background text-ink shadow-card" : "text-ink-muted hover:text-ink"}`}
                      >
                        {COMPETITION_PERIOD_LABELS[p]}
                      </button>
                    );
                  })}
                </div>
                <span className="font-mono text-[11px] text-ink-muted">
                  {period === "month" ? "Monthly prize race" : slice?.periodLabel ?? COMPETITION_PERIOD_LABELS[period]}
                </span>
              </div>

              {failed ? (
                <div className="flex items-center justify-between gap-3 px-4 py-6 text-sm text-ink-soft">
                  <span>Standings are refreshing. Open the full championship board.</span>
                  <Link href="/compete#leaderboard" className="btn-ghost btn-sm shrink-0">Open board</Link>
                </div>
              ) : !slice ? (
                <ul className="divide-y divide-line" aria-label="Loading live standings">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-3">
                      <span className="skeleton h-7 w-7 rounded-full" />
                      <span className="skeleton h-4 flex-1" />
                      <span className="skeleton h-4 w-14" />
                    </li>
                  ))}
                </ul>
              ) : slice.rows.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-ink-soft">
                  <p>No official scores posted for {COMPETITION_PERIOD_LABELS[period].toLowerCase()} yet.</p>
                  <Link href="/compete" className="btn-primary btn-sm mt-3">Set the first score</Link>
                </div>
              ) : (
                <ol className="divide-y divide-line">
                  {slice.rows.map((r) => (
                    <li key={r.entryId} className="grid grid-cols-[2rem_minmax(0,1fr)_auto_2rem] items-center gap-3 px-4 py-2.5">
                      <span className={`mono inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${rankTone(r.rank)}`}>
                        #{r.rank}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-ink">{r.displayName}</span>
                          {r.teamLabel && <span className="hidden truncate text-xs text-ink-muted sm:inline">{r.teamLabel}</span>}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">{r.trackLabel}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="mono text-base font-bold text-ink">{r.overallScore}</span>
                        <span className="chip mono !px-1.5 !py-0 !text-[11px]">{r.grade}</span>
                      </span>
                      <Link
                        href={`/compete/card/${encodeURIComponent(r.shareToken)}`}
                        className="btn-quiet !min-h-[32px] !min-w-[32px] !px-0"
                        aria-label={`View score card for ${r.displayName}`}
                        title="View score card"
                      >
                        <Share2 size={14} strokeWidth={1.75} aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

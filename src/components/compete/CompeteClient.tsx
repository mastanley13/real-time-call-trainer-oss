"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, EyeOff, FileText, Lock, Mic, Pencil, Phone, Share2, Timer, Trophy, Users } from "lucide-react";
import Sheet from "@/components/ui/Sheet";
import RolePlayCard from "@/components/call/RolePlayCard";
import { useAuth } from "@/contexts/AuthContext";
import {
  COMPETITION_CALL_MAX_SECONDS,
  COMPETITION_MAX_ATTEMPTS,
  COMPETITION_MIN_DURATION_SECONDS,
  COMPETITION_MIN_TRAINEE_TURNS,
  COMPETITION_PERIODS,
  COMPETITION_PERIOD_LABELS,
  COMPETITION_PRIZES,
  COMPETITION_TRACKS,
  competitionTrackBySlug,
  getOpeningBoardState,
  type CompetitionLeaderboardRow,
  type CompetitionPeriod,
  type CompetitionStatusResponse,
  type CompetitionTrack,
  type CompetitionTrackSlug,
} from "@/lib/competition";

type Season = CompetitionStatusResponse["season"];
type Viewer = CompetitionStatusResponse["viewer"];
type Entry = Viewer["entries"][number];
export type BoardKey = "overall" | CompetitionTrackSlug;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REFRESH_MS = 60_000;

/** "6:00" from seconds. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function span(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Badge text for the hero: demo preview, time left, time until it opens, or the closed state. */
export function countdownLabel(season: Pick<Season, "phase" | "startAt" | "endAt" | "demoMode">, nowMs: number): string {
  if (season.demoMode) return "Demo preview";
  if (season.phase === "disabled") return "Not open yet";
  if (season.phase === "ended") return "Season ended";
  if (season.phase === "upcoming") {
    const start = season.startAt ? Date.parse(season.startAt) : NaN;
    return Number.isFinite(start) && start > nowMs ? `Opens in ${span(start - nowMs)}` : "Opens soon";
  }
  const end = season.endAt ? Date.parse(season.endAt) : NaN;
  if (!Number.isFinite(end)) return "Live now";
  return end > nowMs ? `${span(end - nowMs)} left` : "Final minutes";
}

export type CompeteCta =
  | { kind: "loading" }
  | { kind: "start"; href: string; label: string }
  | { kind: "guest"; registerHref: string; loginHref: string; note?: string }
  | { kind: "used"; label: string; practiceHref: string }
  | { kind: "closed"; message: string; practiceHref: string }
  | { kind: "unavailable"; message: string };

const PRACTICE_HREF = "/trainer";

function opensOn(startAt: string | null): string {
  const t = startAt ? Date.parse(startAt) : NaN;
  if (!Number.isFinite(t)) return "soon";
  return `on ${new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`;
}

/** The single call to action in the quick brief, from the season phase and the viewer's attempts. */
export function competeCta(input: {
  track: Pick<CompetitionTrack, "slug">;
  season: Season | null;
  viewer: Viewer | null;
  authenticated: boolean;
  loading: boolean;
}): CompeteCta {
  const { track, season, viewer, authenticated, loading } = input;
  if (loading) return { kind: "loading" };
  const nextToTrack = `/trainer?compete=${encodeURIComponent(track.slug)}`;
  const registerHref = `/register?src=compete&seg=${encodeURIComponent(track.slug)}&next=${encodeURIComponent(nextToTrack)}`;
  const loginHref = `/login?next=${encodeURIComponent(nextToTrack)}`;
  if (season && season.phase !== "active") {
    if (season.phase === "upcoming") {
      const message = `The championship opens ${opensOn(season.startAt)}. Practice freely in the trainer until then.`;
      return authenticated ? { kind: "closed", message, practiceHref: PRACTICE_HREF } : { kind: "guest", registerHref, loginHref, note: message };
    }
    const message = season.phase === "ended"
      ? "This season has ended. Final standings are on the leaderboard below."
      : "The championship is not open right now. Practice any persona in the trainer in the meantime.";
    return { kind: "closed", message, practiceHref: PRACTICE_HREF };
  }
  if (!authenticated) return { kind: "guest", registerHref, loginHref };
  if (!season || !viewer) return { kind: "unavailable", message: "We could not load your attempts. Refresh the page to try again." };
  if (season.globalCallsCap > 0 && season.globalCallsUsed >= season.globalCallsCap) {
    return { kind: "closed", message: "Every official call slot for this season is taken. You can still practice freely in the trainer.", practiceHref: PRACTICE_HREF };
  }
  const max = season.maxAttempts || COMPETITION_MAX_ATTEMPTS;
  if (viewer.attemptsRemaining <= 0) return { kind: "used", label: `All ${max} official attempts used`, practiceHref: PRACTICE_HREF };
  const attempt = Math.min(viewer.attemptsUsed + 1, max);
  return { kind: "start", href: `/trainer?compete=${encodeURIComponent(track.slug)}`, label: `Start official call (Attempt ${attempt} of ${max})` };
}

/** Plain status for a past attempt that has no ranked score. */
export function entryStatusLabel(e: Pick<Entry, "status" | "overallScore">): string | null {
  if (e.status === "completed") return e.overallScore == null ? "Did not qualify" : null;
  if (e.status === "minted") return "In progress";
  if (e.status === "refunded") return "Not counted";
  return "Did not finish";
}

const DIFFICULTY: Record<CompetitionTrack["difficulty"], { label: string; lamp: string }> = {
  easy: { label: "Easy", lamp: "lamp-ok" },
  medium: { label: "Medium", lamp: "lamp-signal" },
  hard: { label: "Hard", lamp: "lamp-caution" },
};

function rankBadge(rank: number): string {
  if (rank === 1) return "bg-primary text-primary-on";
  if (rank <= 3) return "bg-primary-soft text-primary";
  return "bg-sunken text-ink-muted";
}

type CacheKey = `${CompetitionPeriod}:${BoardKey}`;

function cacheKey(period: CompetitionPeriod, board: BoardKey): CacheKey {
  return `${period}:${board}`;
}

async function fetchStatus(board: BoardKey, period: CompetitionPeriod, signal?: AbortSignal): Promise<CompetitionStatusResponse> {
  const q = new URLSearchParams({ period });
  if (board !== "overall") q.set("track", board);
  const r = await fetch(`/api/competition?${q.toString()}`, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return (await r.json()) as CompetitionStatusResponse;
}

export default function CompeteClient() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<CompetitionStatusResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [boards, setBoards] = useState<Partial<Record<CacheKey, { rows: CompetitionLeaderboardRow[]; total: number; periodLabel: string }>>>({});
  const [period, setPeriod] = useState<CompetitionPeriod>("month");
  const [board, setBoard] = useState<BoardKey>("overall");
  const [boardError, setBoardError] = useState(false);
  const [briefSlug, setBriefSlug] = useState<CompetitionTrackSlug | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const activeRef = useRef<{ period: CompetitionPeriod; board: BoardKey }>({ period: "month", board: "overall" });
  activeRef.current = { period, board };

  const apply = useCallback((p: CompetitionPeriod, b: BoardKey, data: CompetitionStatusResponse) => {
    setStatus(data);
    setBoards((prev) => ({ ...prev, [cacheKey(p, b)]: { rows: data.leaderboard, total: data.totalQualifiedEntries, periodLabel: data.periodLabel } }));
  }, []);

  const loadOverall = useCallback(() => {
    setFailed(false);
    fetchStatus("overall", "month")
      .then((d) => apply("month", "overall", d))
      .catch(() => setFailed(true));
  }, [apply]);

  useEffect(() => { loadOverall(); }, [loadOverall]);

  // Clock for the countdown, started after mount so the server and first client render match.
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const currentKey = cacheKey(period, board);
  const currentBoard = boards[currentKey];

  // Load any period/track slice the first time it is picked.
  useEffect(() => {
    if (currentKey === "month:overall" || currentBoard) return;
    const ctl = new AbortController();
    setBoardError(false);
    fetchStatus(board, period, ctl.signal)
      .then((d) => apply(period, board, d))
      .catch((e: unknown) => { if (!ctl.signal.aborted && !(e instanceof DOMException && e.name === "AbortError")) setBoardError(true); });
    return () => ctl.abort();
  }, [currentKey, currentBoard, board, period, apply]);

  // Keep the visible board live while the tab is in view.
  useEffect(() => {
    if (status?.season.phase !== "active") return;
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const cur = activeRef.current;
      fetchStatus(cur.board, cur.period).then((d) => apply(cur.period, cur.board, d)).catch(() => { /* keep the last board; the next tick retries */ });
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [status?.season.phase, apply]);

  const season = status?.season ?? null;
  const viewer = status?.viewer ?? null;
  const authenticated = viewer?.authenticated ?? isAuthenticated;
  const loading = (!status && !failed) || authLoading;
  const brief = competitionTrackBySlug(briefSlug);
  const tracks = status?.tracks?.length ? status.tracks : COMPETITION_TRACKS;

  const rules = {
    maxSeconds: season?.maxCallSeconds ?? COMPETITION_CALL_MAX_SECONDS,
    minSeconds: season?.minDurationSeconds ?? COMPETITION_MIN_DURATION_SECONDS,
    minTurns: season?.minTraineeTurns ?? COMPETITION_MIN_TRAINEE_TURNS,
    maxAttempts: season?.maxAttempts ?? COMPETITION_MAX_ATTEMPTS,
  };

  function onHandleSaved(displayName: string, teamLabel: string | null) {
    setStatus((s) => (s ? { ...s, viewer: { ...s.viewer, displayName, teamLabel } } : s));
    setBoards((b) => {
      const next: typeof b = {};
      for (const [k, entry] of Object.entries(b) as [CacheKey, { rows: CompetitionLeaderboardRow[]; total: number; periodLabel: string } | undefined][]) {
        if (!entry) continue;
        next[k] = { ...entry, rows: entry.rows.map((r) => (r.isCurrentUser ? { ...r, displayName, teamLabel } : r)) };
      }
      return next;
    });
  }

  function retryBoard() {
    if (currentKey === "month:overall") { loadOverall(); return; }
    setBoardError(false);
    setBoards((b) => ({ ...b, [currentKey]: undefined }));
  }

  const live = season?.phase === "active";
  const badge = season && now != null ? countdownLabel(season, now) : null;

  return (
    <>
      <section className="deck border-b border-line">
        <div className="page grid gap-8 py-10 sm:py-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-12">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="eyebrow inline-flex items-center gap-2">
                <span className={`lamp ${live ? "lamp-signal animate-lamp-pulse" : "lamp-caution"}`} aria-hidden />
                Monthly sales call championship
              </p>
              {badge && (
                <span className="chip mono !text-[11px]">
                  <Timer size={12} strokeWidth={1.75} aria-hidden /> {badge}
                </span>
              )}
            </div>
            <h1 className="mt-4 max-w-2xl text-4xl font-bold leading-[1.05] sm:text-5xl">3 calls a month. {tracks.length} industries. Prove it on the phone.</h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-soft">
              Pick an industry, read a 30-second brief, and run a {Math.round(rules.maxSeconds / 60)}-minute blind voice call. Climb the day, week, month, and year leaderboards. Monthly #1 wins the prize.
            </p>
            <ul className="mt-5 flex flex-wrap gap-2" aria-label="Championship rules">
              <li className="chip"><Mic size={12} strokeWidth={1.75} aria-hidden /> Voice only</li>
              <li className="chip"><EyeOff size={12} strokeWidth={1.75} aria-hidden /> Blind mode</li>
              <li className="chip"><Timer size={12} strokeWidth={1.75} aria-hidden /> {clockLabel(rules.maxSeconds)} hard timer</li>
              <li className="chip"><Phone size={12} strokeWidth={1.75} aria-hidden /> {rules.maxAttempts} calls / month</li>
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <a href="#tracks" className="btn-primary btn-xl">Pick your industry <ArrowRight size={18} strokeWidth={1.75} aria-hidden /></a>
              <a href="#leaderboard" className="btn-ghost btn-xl">See the leaderboard</a>
            </div>
          </div>

          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1" aria-label="Monthly prizes" role="group">
            <PrizeTile
              icon={<Trophy size={18} strokeWidth={1.75} aria-hidden />}
              eyebrow="Monthly #1 (solo prize)"
              headline={COMPETITION_PRIZES.soloHeadline}
              value={`$${COMPETITION_PRIZES.soloValueUsd} value`}
              detail={COMPETITION_PRIZES.soloDetail}
            />
            <PrizeTile
              icon={<Users size={18} strokeWidth={1.75} aria-hidden />}
              eyebrow="Monthly winner's team bonus"
              headline={COMPETITION_PRIZES.teamHeadline.replace(/^Team winner bonus:\s*/i, "")}
              value={`$${COMPETITION_PRIZES.teamDiscountSeatYearUsd}/seat/yr vs $${COMPETITION_PRIZES.teamRegularSeatYearUsd}`}
              detail={COMPETITION_PRIZES.teamDetail}
            />
          </div>
        </div>
      </section>

      <div className="page space-y-10 sm:space-y-12">
        {failed && (
          <div className="banner-warn flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <span>We could not load the live standings. Check your connection and try again.</span>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={loadOverall}>Try again</button>
          </div>
        )}

        <CompetitorBar
          loading={loading}
          authenticated={authenticated}
          viewer={viewer}
          maxAttempts={rules.maxAttempts}
          onSaved={onHandleSaved}
        />

        <section id="tracks" aria-labelledby="tracks-title" className="scroll-mt-24">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2 id="tracks-title" className="mt-1 text-2xl font-bold">Pick your industry</h2>
            </div>
            <p className="text-sm text-ink-muted">Every rep faces the same buyer and rubric on each track.</p>
          </div>
          <ul className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {tracks.map((t) => (
              <li key={t.slug} className="min-w-0">
                <TrackCard track={t} onOpen={() => setBriefSlug(t.slug)} />
              </li>
            ))}
          </ul>
        </section>

        <Leaderboard
          period={period}
          onPeriod={setPeriod}
          periodLabel={currentBoard?.periodLabel ?? COMPETITION_PERIOD_LABELS[period]}
          board={board}
          onBoard={setBoard}
          rows={currentBoard?.rows}
          failed={currentKey === "month:overall" ? failed : boardError}
          onRetry={retryBoard}
          total={currentBoard?.total ?? status?.totalQualifiedEntries ?? null}
          live={live}
        />
      </div>

      {brief && (
        <BriefSheet
          track={brief}
          rules={rules}
          cta={competeCta({ track: brief, season, viewer, authenticated, loading })}
          onClose={() => setBriefSlug(null)}
        />
      )}
    </>
  );
}

function PrizeTile({ icon, eyebrow, headline, value, detail }: { icon: React.ReactNode; eyebrow: string; headline: string; value: string; detail: string }) {
  return (
    <div className="panel flex min-w-0 flex-col gap-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow inline-flex items-center gap-2">{icon}{eyebrow}</p>
        <span className="chip mono shrink-0 !text-[11px] text-ok">{value}</span>
      </div>
      <p className="font-heading text-lg font-bold leading-snug text-ink">{headline}</p>
      <p className="text-sm leading-relaxed text-ink-soft">{detail}</p>
    </div>
  );
}

function AttemptDots({ used, max }: { used: number; max: number }) {
  const left = Math.max(0, max - used);
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={`${left} of ${max} attempts left`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`lamp ${i < left ? "lamp-ok" : "lamp-off"}`} />
      ))}
    </span>
  );
}

function CompetitorBar({ loading, authenticated, viewer, maxAttempts, onSaved }: {
  loading: boolean;
  authenticated: boolean;
  viewer: Viewer | null;
  maxAttempts: number;
  onSaved: (displayName: string, teamLabel: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (loading) {
    return (
      <section aria-label="Your championship status" className="card">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton mt-3 h-4 w-full max-w-md" />
      </section>
    );
  }

  if (!authenticated) {
    return (
      <section aria-labelledby="join-title" className="card flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Free to enter</p>
          <h2 id="join-title" className="mt-1 text-xl font-bold">Create a free account to get your {maxAttempts} official calls</h2>
          <p className="mt-1 text-sm text-ink-soft">You pick a public handle. Your email never shows on the leaderboard or share cards.</p>
        </div>
        <div className="flex flex-wrap gap-2 md:shrink-0">
          <Link href={`/register?src=compete&next=${encodeURIComponent("/compete")}`} className="btn-primary">Create free account</Link>
          <Link href={`/login?next=${encodeURIComponent("/compete")}`} className="btn-ghost">Sign in</Link>
        </div>
      </section>
    );
  }

  if (!viewer) return null;
  const used = Math.min(viewer.attemptsUsed, maxAttempts);
  const entries = [...viewer.entries].sort((a, b) => a.attemptNumber - b.attemptNumber);

  return (
    <section aria-labelledby="you-title" className="card">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Your championship</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2 id="you-title" className="truncate text-xl font-bold">{viewer.displayName || "Competitor"}</h2>
            {viewer.teamLabel && <span className="chip">{viewer.teamLabel}</span>}
            {!editing && (
              <button type="button" className="btn-quiet btn-sm" onClick={() => setEditing(true)}>
                <Pencil size={13} strokeWidth={1.75} aria-hidden /> Edit handle
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-muted">This is how you appear on the public leaderboard. Your email is never shown.</p>
        </div>
        <dl className="grid grid-cols-3 gap-3 sm:gap-6 lg:shrink-0">
          <div className="min-w-0">
            <dt className="label">Attempts left</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="mono text-lg font-semibold text-ink">{viewer.attemptsRemaining} / {maxAttempts}</span>
              <AttemptDots used={used} max={maxAttempts} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="label">Best score</dt>
            <dd className="mono text-lg font-semibold text-ink">{viewer.bestScore ?? "--"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="label">Overall rank</dt>
            <dd className="mono text-lg font-semibold text-ink">{viewer.overallRank ? `#${viewer.overallRank}` : "--"}</dd>
          </div>
        </dl>
      </div>

      {editing && (
        <HandleForm
          initialName={viewer.displayName ?? ""}
          initialTeam={viewer.teamLabel ?? ""}
          onCancel={() => setEditing(false)}
          onSaved={(n, t) => { onSaved(n, t); setEditing(false); }}
        />
      )}

      {entries.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="label">Your attempts</h3>
          <ul className="mt-2 divide-y divide-line">
            {entries.map((e) => {
              const note = entryStatusLabel(e);
              const scored = e.status === "completed" && e.overallScore != null;
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-sm">
                  <span className="mono w-20 shrink-0 text-ink-muted">Attempt {e.attemptNumber}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{e.trackLabel}</span>
                  {scored ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="mono font-semibold text-ink">{e.overallScore}</span>
                      {e.grade && <span className="chip mono">{e.grade}</span>}
                    </span>
                  ) : (
                    <span className="text-ink-muted">{note}</span>
                  )}
                  <span className="flex items-center gap-1">
                    {e.trainerSessionId && (
                      <Link href={`/trainer/debrief/${encodeURIComponent(e.trainerSessionId)}`} className="btn-quiet btn-sm">
                        <FileText size={13} strokeWidth={1.75} aria-hidden /> Debrief
                      </Link>
                    )}
                    {scored && (
                      <Link href={`/compete/card/${encodeURIComponent(e.shareToken)}`} className="btn-quiet btn-sm">
                        <Share2 size={13} strokeWidth={1.75} aria-hidden /> Share card
                      </Link>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function HandleForm({ initialName, initialTeam, onCancel, onSaved }: {
  initialName: string;
  initialTeam: string;
  onCancel: () => void;
  onSaved: (displayName: string, teamLabel: string | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [team, setTeam] = useState(initialTeam);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const displayName = name.trim();
    if (!displayName) { setError("Enter a public handle so the leaderboard can show your score."); nameRef.current?.focus(); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/competition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, teamLabel: team.trim() || null }),
      });
      const body = (await r.json().catch(() => ({}))) as { displayName?: string; teamLabel?: string | null; message?: string };
      if (!r.ok) throw new Error(body.message || "Could not save your handle. Check your connection and try again.");
      onSaved(body.displayName ?? displayName, body.teamLabel === undefined ? team.trim() || null : body.teamLabel);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not save your handle. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form id="handle-form" onSubmit={submit} className="mt-5 grid gap-4 rounded-panel border border-line bg-sunken p-4 sm:grid-cols-2" noValidate>
      <div className="min-w-0">
        <label htmlFor="compete-handle" className="label">Public handle</label>
        <input id="compete-handle" ref={nameRef} className="input" value={name} maxLength={40} autoComplete="nickname"
          onChange={(e) => setName(e.target.value)} aria-invalid={error && !name.trim() ? true : undefined} aria-describedby={error ? "handle-error" : undefined} />
      </div>
      <div className="min-w-0">
        <label htmlFor="compete-team" className="label">Team or company (optional)</label>
        <input id="compete-team" className="input" value={team} maxLength={48} autoComplete="organization" onChange={(e) => setTeam(e.target.value)} />
      </div>
      {error && <p id="handle-error" className="field-msg sm:col-span-2" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className="btn-primary btn-sm" aria-disabled={busy || undefined}>{busy ? "Saving" : "Save handle"}</button>
        <button type="button" className="btn-quiet btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function TrackCard({ track, onOpen }: { track: CompetitionTrack; onOpen: () => void }) {
  const d = DIFFICULTY[track.difficulty];
  return (
    <article className="card card-hover flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-lg font-bold leading-snug">{track.label}</h3>
        <span className="chip shrink-0"><span className={`lamp ${d.lamp} !h-1.5 !w-1.5`} aria-hidden />{d.label}</span>
      </div>
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
        {track.callTypeLabel} <span aria-hidden>·</span> vs. {track.buyerName}
      </p>
      <p className="text-sm leading-relaxed text-ink-soft">{track.shortPitch}</p>
      <div className="rounded-lg border border-line bg-sunken/60 px-3 py-2 text-xs">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">You&rsquo;re pitching</p>
        <p className="mt-0.5 line-clamp-2 font-medium leading-snug text-ink">{track.roleCard.pitching}</p>
      </div>
      <button type="button" className="btn-ghost mt-auto w-full" onClick={onOpen} aria-haspopup="dialog">
        Quick brief &amp; start <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
        <span className="sr-only">: {track.label}</span>
      </button>
    </article>
  );
}

function BriefSheet({ track, rules, cta, onClose }: {
  track: CompetitionTrack;
  rules: { maxSeconds: number; minSeconds: number; minTurns: number; maxAttempts: number };
  cta: CompeteCta;
  onClose: () => void;
}) {
  const d = DIFFICULTY[track.difficulty];
  return (
    <Sheet title={track.label} subtitle={`${track.buyerName} · ${track.callTypeLabel}`} onClose={onClose} footer={<BriefCta cta={cta} />}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip"><span className={`lamp ${d.lamp} !h-1.5 !w-1.5`} aria-hidden />{d.label}</span>
        <span className="chip">{track.callTypeLabel}</span>
        <span className="chip">Buyer: {track.buyerName}</span>
      </div>

      <div className="mt-4">
        <RolePlayCard card={track.roleCard} buyerName={track.buyerName} compact />
      </div>

      <h3 className="label mt-6">Your goal</h3>
      <p className="text-[15px] leading-relaxed text-ink">{track.quickBriefGoal}</p>

      <h3 className="label mt-6">Watch out for</h3>
      <ul className="space-y-2.5">
        {track.watchOuts.map((w) => (
          <li key={w} className="flex gap-3 text-sm leading-relaxed text-ink">
            <span className="lamp lamp-caution mt-[0.5em]" aria-hidden />
            <span>{w}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 rounded-panel border border-line bg-sunken p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="label !mb-0 inline-flex items-center gap-1.5"><Lock size={12} strokeWidth={1.75} aria-hidden /> Competition rules</h3>
          <span className="chip !text-[11px]">Locked</span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-2">
          <li className="chip bg-surface">Voice only</li>
          <li className="chip bg-surface">Blind mode (no live cues)</li>
          <li className="chip bg-surface mono">{clockLabel(rules.maxSeconds)} hard timer</li>
          <li className="chip bg-surface">Min {rules.minSeconds}s &amp; {rules.minTurns} turns</li>
          <li className="chip bg-surface">Counts as 1 of {rules.maxAttempts} attempts</li>
        </ul>
      </div>
    </Sheet>
  );
}

function BriefCta({ cta }: { cta: CompeteCta }) {
  switch (cta.kind) {
    case "loading":
      return <button type="button" className="btn-primary btn-xl w-full" disabled aria-busy="true">Checking your attempts</button>;
    case "start":
      return (
        <Link href={cta.href} className="btn-primary btn-xl w-full" data-autofocus>
          <Phone size={18} strokeWidth={1.75} aria-hidden /> {cta.label}
        </Link>
      );
    case "guest":
      return (
        <div className="space-y-2">
          {cta.note && <p className="banner-info">{cta.note}</p>}
          <Link href={cta.registerHref} className="btn-primary btn-xl w-full" data-autofocus>Create free account to compete</Link>
          <Link href={cta.loginHref} className="btn-quiet w-full">Already have an account? Sign in</Link>
        </div>
      );
    case "used":
      return (
        <div className="space-y-2">
          <button type="button" className="btn-primary btn-xl w-full" disabled>{cta.label}</button>
          <Link href={cta.practiceHref} className="btn-ghost w-full" data-autofocus>Practice freely in the trainer</Link>
        </div>
      );
    case "closed":
      return (
        <div className="space-y-2">
          <p className="banner-info">{cta.message}</p>
          <Link href={cta.practiceHref} className="btn-ghost w-full" data-autofocus>Practice in the trainer</Link>
        </div>
      );
    case "unavailable":
      return <p className="banner-warn" role="alert">{cta.message}</p>;
  }
}

function Leaderboard({ period, onPeriod, periodLabel, board, onBoard, rows, failed, onRetry, total, live }: {
  period: CompetitionPeriod;
  onPeriod: (p: CompetitionPeriod) => void;
  periodLabel: string;
  board: BoardKey;
  onBoard: (b: BoardKey) => void;
  rows: CompetitionLeaderboardRow[] | undefined;
  failed: boolean;
  onRetry: () => void;
  total: number | null;
  live: boolean;
}) {
  const filters: { key: BoardKey; label: string }[] = [{ key: "overall", label: "Overall" }, ...COMPETITION_TRACKS.map((t) => ({ key: t.slug, label: t.shortLabel }))];
  const showTrack = board === "overall";
  const trackName = board === "overall" ? null : competitionTrackBySlug(board)?.label ?? null;
  const opening = rows ? getOpeningBoardState(rows.length, periodLabel, trackName) : null;

  return (
    <section id="leaderboard" aria-labelledby="board-title" className="scroll-mt-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow inline-flex items-center gap-2">
            <span className={`lamp ${live ? "lamp-signal" : "lamp-off"} !h-1.5 !w-1.5`} aria-hidden /> {live ? "Live leaderboard" : "Leaderboard"} · {periodLabel}
          </p>
          <h2 id="board-title" className="mt-1 text-2xl font-bold">{trackName ? `${trackName} standings` : "Overall standings"}</h2>
        </div>
        {total != null && <p className="mono text-sm text-ink-muted">{total} official {total === 1 ? "score" : "scores"} posted</p>}
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="segmented w-max" role="group" aria-label="Filter the leaderboard by time window">
          {COMPETITION_PERIODS.map((p) => {
            const on = p === period;
            return (
              <button key={p} type="button" aria-pressed={on} onClick={() => onPeriod(p)}
                className={`segmented-btn whitespace-nowrap ${on ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink"}`}>
                {COMPETITION_PERIOD_LABELS[p]}
                {p === "month" && <span className="ml-1.5 rounded bg-primary-soft px-1.5 py-px font-mono text-[10px] font-semibold text-primary">Prize</span>}
              </button>
            );
          })}
        </div>
        {period === "month" && (
          <p className="text-xs text-ink-muted">Monthly #1 wins 1 year of Pro free plus the Team upgrade bonus.</p>
        )}
      </div>

      <div className="scroll-thin -mx-4 mt-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <div className="segmented w-max" role="group" aria-label="Filter the leaderboard by track">
          {filters.map((f) => {
            const on = f.key === board;
            return (
              <button key={f.key} type="button" aria-pressed={on} onClick={() => onBoard(f.key)}
                className={`segmented-btn whitespace-nowrap ${on ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink"}`}>
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel mt-4 overflow-hidden" aria-busy={!rows && !failed}>
        <div className={`hidden gap-4 border-b border-line bg-sunken px-4 py-2.5 sm:grid ${showTrack ? "sm:grid-cols-[3rem_minmax(0,1fr)_10rem_9rem_2.5rem]" : "sm:grid-cols-[3rem_minmax(0,1fr)_9rem_2.5rem]"}`} aria-hidden>
          <span className="label !mb-0">Rank</span>
          <span className="label !mb-0">Competitor</span>
          {showTrack && <span className="label !mb-0">Track</span>}
          <span className="label !mb-0 text-right">Score</span>
          <span className="sr-only">Share</span>
        </div>

        {failed ? (
          <div className="flex flex-col items-start gap-3 p-5 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <span>Could not load this leaderboard.</span>
            <button type="button" className="btn-ghost btn-sm" onClick={onRetry}>Try again</button>
          </div>
        ) : !rows ? (
          <ul className="divide-y divide-line" aria-label="Loading standings">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 px-4 py-3.5"><div className="skeleton h-8 w-8" /><div className="skeleton h-4 flex-1" /><div className="skeleton h-4 w-16" /></li>
            ))}
          </ul>
        ) : (
          <>
            {opening?.gathering && (
              <div className="flex flex-col gap-1 border-b border-line bg-sunken/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                    <span className="lamp lamp-signal !h-1.5 !w-1.5" aria-hidden />
                    {opening.headline}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-soft">{opening.detail}</p>
                </div>
                <span className="chip mono shrink-0 self-start !text-[11px] sm:self-center">{opening.progressLabel}</span>
              </div>
            )}
            <ol className="divide-y divide-line">
              {rows.map((r) => <BoardRow key={r.entryId} row={r} showTrack={showTrack} />)}
              {opening?.openRanks.map((rank, i) => (
                <OpenBoardRow key={`open-${rank}`} rank={rank} showTrack={showTrack} primary={i === 0} />
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function OpenBoardRow({ rank, showTrack, primary }: { rank: number; showTrack: boolean; primary: boolean }) {
  return (
    <li className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:gap-4 ${showTrack ? "sm:grid-cols-[3rem_minmax(0,1fr)_10rem_11.5rem]" : "sm:grid-cols-[3rem_minmax(0,1fr)_11.5rem]"}`}>
      <span className="mono inline-flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-line bg-sunken/60 text-sm font-semibold text-ink-muted sm:h-9 sm:w-9">
        <span className="sr-only">Open rank </span>#{rank}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink-soft">
          {rank === 1 ? "Open #1 spot" : `Open #${rank} spot`}
        </span>
        <span className="mt-0.5 block truncate text-xs text-ink-muted">
          {rank === 1 ? "Set the first official score on the board" : "Take an official call to claim this spot"}
        </span>
      </span>
      {showTrack && <span className="hidden truncate text-xs text-ink-muted sm:block">Any track</span>}
      <span className="flex items-center justify-end">
        {primary ? (
          <a href="#tracks" className="btn-ghost btn-sm shrink-0">
            Claim #{rank}
          </a>
        ) : (
          <span className="mono text-xs uppercase tracking-[0.06em] text-ink-muted">Open spot</span>
        )}
      </span>
    </li>
  );
}

function BoardRow({ row, showTrack }: { row: CompetitionLeaderboardRow; showTrack: boolean }) {
  const track = competitionTrackBySlug(row.trackSlug);
  return (
    <li className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto_2.5rem] items-center gap-3 px-4 py-3 sm:gap-4 ${showTrack ? "sm:grid-cols-[3rem_minmax(0,1fr)_10rem_9rem_2.5rem]" : "sm:grid-cols-[3rem_minmax(0,1fr)_9rem_2.5rem]"} ${row.isCurrentUser ? "bg-primary-soft/40" : ""}`}>
      <span className={`mono inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold sm:h-9 sm:w-9 ${rankBadge(row.rank)}`}>
        <span className="sr-only">Rank </span>#{row.rank}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-semibold text-ink">{row.displayName}</span>
          {row.teamLabel && <span className="truncate text-xs text-ink-muted">{row.teamLabel}</span>}
          {row.isCurrentUser && <span className="chip !border-primary/40 !py-0 !text-[11px] text-primary">You</span>}
        </span>
        {showTrack && <span className="mt-0.5 block truncate text-xs text-ink-muted sm:hidden">{row.trackLabel || track?.shortLabel}</span>}
      </span>
      {showTrack && <span className="hidden truncate text-sm text-ink-soft sm:block">{row.trackLabel || track?.label}</span>}
      <span className="flex items-center justify-end gap-2">
        <span className={`lamp ${row.goalAchieved ? "lamp-ok" : "lamp-off"} !h-1.5 !w-1.5`} title={row.goalAchieved ? "Goal met" : "Goal not met"} aria-hidden />
        <span className="sr-only">{row.goalAchieved ? "Goal met, " : "Goal not met, "}score </span>
        <span className="mono text-lg font-bold text-ink">{row.overallScore}</span>
        <span className="chip mono !px-2 !py-0">{row.grade}</span>
      </span>
      <Link href={`/compete/card/${encodeURIComponent(row.shareToken)}`} className="btn-quiet !min-h-[36px] !min-w-[36px] !px-0" aria-label={`Open the share card for ${row.displayName}`} title="Share card">
        <Share2 size={16} strokeWidth={1.75} aria-hidden />
      </Link>
    </li>
  );
}

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import type { CoachLog } from "@/lib/sessionStore";
import type { Scenario } from "@/lib/scenarios";
import type { Evaluation } from "@/lib/grader-types";
import { goalStatusOf, graderLabel, isLegacyGrader, scoreLabel } from "@/lib/grader-types";
import { anchorQuote, lacksEvidence, nextMove, plainRationale, plainSummary, retryHref, type NextMove } from "@/lib/debrief";
import { CUE_LABELS } from "@/lib/coach-types";
import { formatDuration } from "@/lib/format";
import { voiceLabel } from "@/lib/billingUi";
import { PersonaAvatar } from "@/components/ui/Persona";
import { DEBRIEF_HEADLINE, NEXT_MOVE_LABELS, NEXT_MOVE_NOTES, QUOTE_LABELS, SCORE_COPY, STATE_COPY } from "./debriefCopy";

/**
 * The debrief, "Next move first": one improvement from the stored grade (the buyer's exact words, the grader's reading,
 * a labelled suggestion and one targeted retry), then the score with its definition and limits, the full rubric with
 * anchored evidence, and the full transcript. Pure render: the page loads the session and owns re-grading.
 */

export interface DebriefView {
  title: string;
  scenario?: Scenario;
  scenarioId?: string;
  createdAt: string;
  durationSeconds: number;
  transcript: { role: string; text: string }[];
  evaluation: Evaluation | null;
  supervisorNotes?: string | null;
  callerName: string;
  coach?: CoachLog;
  /** Voice tier the call ran on, for server-stored voice calls. Never a model id. */
  voiceUsed?: "premium" | "standard" | null;
}

export interface DebriefReportProps {
  sessionId: string;
  view: DebriefView;
  /** Another persona that drills the weakest criterion. */
  drill?: Scenario;
  /** The transcript line the rep last jumped to. */
  focusLine?: number | null;
  /** Scrolls to and focuses a transcript line. Without it the links still work as plain #turn-N anchors. */
  onJump?: (line: number) => void;
  /** Re-grade button, its status and hints, built by the page. Shown with the score, or with the "wasn't graded" notice. */
  gradeControls?: ReactNode;
  onPrint?: () => void;
}

export const turnId = (line: number) => `turn-${line}`;

const GOAL = { achieved: "Goal achieved", partial: "Goal partly met", not_achieved: "Goal missed" } as const;
const H2 = "text-xl font-bold leading-7 sm:text-2xl sm:leading-8";
const PANEL = "min-w-0 rounded-panel border border-line p-5 sm:p-6";
const LINK = "rounded-control font-semibold text-primary underline underline-offset-4 hover:text-primary-hover";

function TurnLink({ line, onJump, className = LINK, children }: { line: number; onJump?: (line: number) => void; className?: string; children: ReactNode }) {
  const click = onJump && ((e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); onJump(line); });
  return <a href={`#${turnId(line)}`} onClick={click} className={className} data-turn-link={line}>{children}</a>;
}

/** An empty or failed state: what happened, and one clear next action. */
export function DebriefState({ title, body, action, href, headingLevel = 2 }: { title: string; body: string; action: string; href: string; headingLevel?: 1 | 2 }) {
  const H = headingLevel === 1 ? "h1" : "h2";
  return (
    <section aria-labelledby="state-h" data-state="" className="max-w-[60ch] rounded-panel bg-sunken p-6 sm:p-8">
      <H id="state-h" className={headingLevel === 1 ? "text-2xl font-bold leading-8 sm:text-[28px] sm:leading-9" : H2}>{title}</H>
      <p className="mt-3 text-ink-soft">{body}</p>
      <Link href={href} className="btn-primary btn-lg mt-6">{action}</Link>
    </section>
  );
}

function NextMoveCard({ move, view, sessionId, onJump }: { move: NextMove; view: DebriefView; sessionId: string; onJump?: (line: number) => void }) {
  const practiceHref = view.scenarioId ? `/trainer?scenario=${encodeURIComponent(view.scenarioId)}` : "/trainer";
  return (
    <section aria-labelledby="next-h" data-next-move="" className="min-w-0 rounded-panel bg-sunken p-6 sm:p-8">
      <p className="text-sm font-semibold leading-5">Your next practice focus</p>
      <h2 id="next-h" className="mt-4 max-w-[18ch] text-[30px] font-bold leading-[1.15] sm:text-[36px] lg:text-[40px]">{DEBRIEF_HEADLINE}</h2>
      <p className="mt-4 max-w-[60ch] text-lg leading-7">
        Focus on <strong>{move.criterion}</strong>. It is your lowest rubric score, <span className="mono">{move.score}</span> of 100.
      </p>
      <div className="mt-6 space-y-6 border-t border-line pt-6">
        {move.buyerSaid && move.turn && (
          <div data-part="buyer-said">
            <h3 className="text-sm font-semibold leading-5">{NEXT_MOVE_LABELS.buyerSaid}</h3>
            <blockquote className="mt-2 max-w-[60ch] whitespace-pre-wrap break-words text-xl leading-8">
              &ldquo;<span data-exact-quote="">{move.buyerSaid}</span>&rdquo;
            </blockquote>
            <p className="mt-2 text-sm leading-5 text-ink-soft">
              {view.callerName}, <TurnLink line={move.turn} onJump={onJump}>turn {move.turn} in the transcript</TurnLink>
            </p>
          </div>
        )}
        {move.whatHappened && (
          <div data-part="what-happened">
            <h3 className="text-sm font-semibold leading-5">{NEXT_MOVE_LABELS.whatHappened}</h3>
            <p className="mt-2 max-w-[60ch]">{move.whatHappened}</p>
            <p className="mt-2 text-sm leading-5 text-ink-soft">{NEXT_MOVE_NOTES.whatHappened}</p>
          </div>
        )}
        {move.trySaying && (
          <div data-part="try-saying">
            <h3 className="text-sm font-semibold leading-5">{NEXT_MOVE_LABELS.trySaying}</h3>
            <p className="mt-2 max-w-[60ch] break-words text-lg leading-7">&ldquo;{move.trySaying}&rdquo;</p>
            <p className="mt-2 text-sm leading-5 text-ink-soft">{NEXT_MOVE_NOTES.trySaying}</p>
          </div>
        )}
      </div>
      <div className="mt-8 print:hidden">
        {move.turn ? (
          <>
            <Link href={retryHref(sessionId, move.turn, view.scenarioId)} data-retry="" className="btn-primary btn-lg w-full sm:w-auto">Retry from turn {move.turn}</Link>
            <p className="mt-2 text-sm leading-5 text-ink-soft">Picks the call back up right after the buyer&rsquo;s line at turn {move.turn}, in text mode.</p>
          </>
        ) : (
          <Link href={practiceHref} className="btn-primary btn-lg w-full sm:w-auto">Practice this persona again</Link>
        )}
      </div>
    </section>
  );
}

function ScorePanel({ ev, transcript, gradeControls }: { ev: Evaluation; transcript: DebriefView["transcript"]; gradeControls?: ReactNode }) {
  const rules = ev.method !== "llm" || isLegacyGrader(ev);
  const copy = rules ? SCORE_COPY.rules : SCORE_COPY.ai;
  return (
    <section aria-labelledby="score-h" data-score="" className={PANEL}>
      <h2 id="score-h" className="text-lg font-bold leading-7">{copy.heading}</h2>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mono text-2xl font-semibold leading-8">{ev.overallScore}<span className="text-base font-normal text-ink-soft">/100</span></span>
        <span className="text-ink-soft">Grade {ev.grade} · {scoreLabel(ev.overallScore)}</span>
      </p>
      <p className="mt-2"><span className="badge-tag">{GOAL[goalStatusOf(ev)]}</span></p>
      <p className="mt-3 text-sm leading-5 text-ink-soft">{copy.definition}</p>
      {ev.note && <p className="mt-2 text-sm leading-5 text-ink-soft">{ev.note}</p>}
      {lacksEvidence(transcript, ev) &&<p role="note" data-insufficient-evidence="" className="banner-warn mt-3">{STATE_COPY.insufficientEvidence}</p>}
      <p className="mt-3"><a href="#rubric-h" className={`${LINK} inline-flex min-h-[44px] items-center`}>{SCORE_COPY.evidenceLink}</a></p>
      {gradeControls && <div className="mt-3 space-y-2 border-t border-line pt-3 print:hidden">{gradeControls}</div>}
    </section>
  );
}

function Evidence({ e, view, onJump }: { e: Evaluation["criteria"][number]["evidence"][number]; view: DebriefView; onJump?: (line: number) => void }) {
  const a = anchorQuote(view.transcript, e);
  const who = e.speaker === "trainee" ? "You" : view.callerName;
  return (
    <li data-quote={a.status} className="min-w-0">
      <blockquote className="quote whitespace-pre-wrap break-words">&ldquo;{e.quote}&rdquo;</blockquote>
      <p className="mt-1 text-sm leading-5 text-ink-soft">
        {who}
        {a.status !== "unmatched" && <>, <TurnLink line={a.line} onJump={onJump}>turn {a.line}</TurnLink></>}
        {a.status === "inexact" && <span className="font-semibold text-caution"> {QUOTE_LABELS.inexact(a.line)}</span>}
        {a.status === "unmatched" && <span className="font-semibold text-caution"> {QUOTE_LABELS.unmatched}</span>}
      </p>
    </li>
  );
}

export default function DebriefReport({ sessionId, view, drill, focusLine = null, onJump, gradeControls, onPrint }: DebriefReportProps) {
  const ev = view.evaluation;
  const move = ev ? nextMove(view.transcript, ev, view.scenario) : null;
  const spoke = view.transcript.some((t) => t.role === "user" && t.text.trim());
  const practiceHref = view.scenarioId ? `/trainer?scenario=${encodeURIComponent(view.scenarioId)}` : "/trainer";
  const cues = view.coach?.cues ?? [];
  const cueTurns = new Map(cues.map((c) => [c.triggerTurn, c]));
  /**
   * For each transcript line, the criteria that cite it: "exact" when a quote matches the line word for word, "inexact"
   * when the grader cited the line but its wording differs. Unanchored quotes have no line to mark.
   */
  const lineCriteria: Record<number, { exact: string[]; inexact: string[] }> = {};
  for (const c of ev?.criteria ?? []) for (const e of c.evidence) {
    const a = anchorQuote(view.transcript, e);
    if (a.status === "unmatched") continue;
    const marks = (lineCriteria[a.line] ??= { exact: [], inexact: [] });
    if (!marks[a.status].includes(c.name)) marks[a.status].push(c.name);
  }
  const meta = [
    new Date(view.createdAt).toLocaleString(),
    formatDuration(view.durationSeconds),
    `${view.transcript.length} turns`,
    ...(view.coach ? [`coach ${view.coach.mode}`] : []),
    ...(view.voiceUsed ? [voiceLabel(view.voiceUsed)] : []),
  ].join(" · ");

  const empty = view.transcript.length === 0 ? STATE_COPY.noTranscript : !spoke ? STATE_COPY.nothingSaid : null;

  return (
    <div className="focus-strong text-base leading-6">
      <div className="site-wrap py-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-5 text-ink-soft">Debrief</p>
            <h1 className="mt-1 break-words text-2xl font-bold leading-8 sm:text-[28px] sm:leading-9">{view.title}</h1>
            <p className="mt-2 text-sm leading-5 text-ink-soft">{meta}</p>
          </div>
          <div className="flex flex-wrap gap-3 print:hidden">
            {onPrint && <button type="button" className="btn-ghost btn-lg" onClick={onPrint}>Print</button>}
            <Link href={practiceHref} className="btn-ghost btn-lg">Practice again</Link>
          </div>
        </header>

        {empty ? (
          <div className="mt-8"><DebriefState {...empty} href={practiceHref} /></div>
        ) : (
          <>
            <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-12">
              {move ? (
                <NextMoveCard move={move} view={view} sessionId={sessionId} onJump={onJump} />
              ) : (
                <section aria-labelledby="ungraded-h" data-state="" className="min-w-0 rounded-panel bg-sunken p-6 sm:p-8">
                  <h2 id="ungraded-h" className={H2}>{ev ? "No rubric in this grade" : "This call wasn't graded"}</h2>
                  <p className="mt-3 max-w-[60ch] text-ink-soft">{ev ? "This grade has no rubric scores to pick a next move from. Your transcript is saved below." : STATE_COPY.notGraded}</p>
                  {!ev && gradeControls && <div className="mt-4 max-w-sm space-y-2 print:hidden">{gradeControls}</div>}
                  <p className="mt-6"><a href="#tx-h" className={`${LINK} inline-flex min-h-[44px] items-center`}>Read the full transcript</a></p>
                </section>
              )}

              <div className="min-w-0 space-y-6">
                {ev && <ScorePanel ev={ev} transcript={view.transcript} gradeControls={gradeControls} />}
                {view.supervisorNotes && (
                  <section aria-labelledby="notes-h" className={PANEL}>
                    <h2 id="notes-h" className="text-lg font-bold leading-7">Supervisor notes</h2>
                    <p className="mt-2 whitespace-pre-wrap break-words text-ink-soft">{view.supervisorNotes}</p>
                  </section>
                )}
                {view.coach && (
                  <section aria-labelledby="coach-h" className={PANEL}>
                    <h2 id="coach-h" className="text-lg font-bold leading-7">Live coach</h2>
                    <p className="mt-2 text-ink-soft">
                      <span className="mono">{cues.length}</span> {cues.length === 1 ? "cue" : "cues"}, <span className="mono">{cues.filter((c) => c.used).length}</span> used, {view.coach.mode} mode. Cues are marked in the transcript.
                    </p>
                  </section>
                )}
                {drill && (
                  <section aria-labelledby="drill-h" className={`${PANEL} print:hidden`}>
                    <h2 id="drill-h" className="text-lg font-bold leading-7">Another buyer for this skill</h2>
                    <div className="mt-3 flex items-center gap-3">
                      <PersonaAvatar scenario={drill} size={40} />
                      <div className="min-w-0">
                        <p className="break-words font-semibold">{drill.aiPersona.name}</p>
                        <p className="break-words text-sm leading-5 text-ink-soft">{drill.title}</p>
                      </div>
                    </div>
                    <Link href={`/trainer?scenario=${encodeURIComponent(drill.id)}`} className="btn-ghost btn-lg mt-4 w-full">Open the briefing</Link>
                  </section>
                )}
              </div>
            </div>

            {ev && (
              <section aria-labelledby="summary-h" className="mt-12 border-t border-line pt-8">
                <h2 id="summary-h" className={H2}>Summary</h2>
                <p className="mt-3 max-w-[70ch]">{plainSummary(ev)}</p>
                {ev.goalAchievement.explanation && <p className="mt-2 max-w-[70ch] text-ink-soft">{ev.goalAchievement.explanation}</p>}
                <div className="mt-6 grid gap-8 md:grid-cols-2">
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold leading-7">Strengths</h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-soft">{ev.strengths.length ? ev.strengths.map((x, i) => <li key={i}>{x}</li>) : <li>Nothing stood out this time. Keep practicing and your strengths will show up here.</li>}</ul>
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold leading-7">To improve</h3>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-soft">{ev.improvements.length ? ev.improvements.map((x, i) => <li key={i}>{x}</li>) : <li>Nothing major to fix.</li>}</ul>
                  </div>
                </div>
              </section>
            )}

            {ev && ev.criteria.length > 0 && (
              <section aria-labelledby="rubric-h" className="mt-12 border-t border-line pt-8">
                <h2 id="rubric-h" className={`${H2} scroll-mt-[calc(var(--header-h,3.5rem)+1rem)]`}>Rubric and evidence</h2>
                <p className="mt-2 max-w-[70ch] text-ink-soft">Each score with the grader&rsquo;s reasoning and the quotes behind it. Quote links jump to the transcript.</p>
                <ul className="mt-4">
                  {ev.criteria.map((c) => (
                    <li key={c.id} data-criterion={c.id} className="grid gap-4 border-b border-line py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-10">
                      <div className="min-w-0">
                        <h3 className="break-words text-lg font-bold leading-7">{c.name}</h3>
                        {move?.criterionId === c.id &&<p className="mt-1"><span className="badge-tag">Next move</span></p>}
                        <p className="mt-2 text-ink-soft"><span className="mono font-semibold text-ink">{c.score}</span>/100 · weight <span className="mono">{Math.round(c.weight)}%</span></p>
                        <div role="meter" aria-label={`${c.name}: ${c.score} of 100`} aria-valuenow={c.score} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-sunken">
                          <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, c.score))}%` }} />
                        </div>
                      </div>
                      <div className="min-w-0">
                        <p className="max-w-[70ch]">{plainRationale(c.rationale)}</p>
                        {c.evidence.length > 0 ? (
                          <ul className="mt-3 space-y-3">{c.evidence.map((e, i) => <Evidence key={i} e={e} view={view} onJump={onJump} />)}</ul>
                        ) : <p className="mt-3 text-sm leading-5 text-ink-soft">{STATE_COPY.noCriterionEvidence}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {view.transcript.length > 0 && (
          <section aria-labelledby="tx-h" className="mt-12 border-t border-line pt-8">
            <h2 id="tx-h" className={`${H2} scroll-mt-[calc(var(--header-h,3.5rem)+1rem)]`}>Full transcript</h2>
            <ol className="mt-4 space-y-1">
              {view.transcript.map((t, i) => {
                const line = i + 1;
                const me = t.role === "user";
                const cue = cueTurns.get(line);
                const cited = lineCriteria[line];
                // A name with an exact quote on this line is evidence; one cited only with different wording is qualified.
                const exact = cited?.exact ?? [];
                const inexact = (cited?.inexact ?? []).filter((n) => !exact.includes(n));
                // The buyer line the next move quotes stays marked until the rep jumps somewhere else.
                const lit = focusLine === line || (!focusLine && !!move?.buyerSaid && move.turn === line);
                return (
                  <li key={i} id={turnId(line)} tabIndex={-1} data-turn=""
                    className={`grid scroll-mt-[calc(var(--header-h,3.5rem)+1rem)] grid-cols-[3.5rem_minmax(0,1fr)] gap-3 rounded-panel px-3 py-3 target:bg-sunken focus:outline focus:outline-[3px] focus:outline-offset-2 focus:outline-primary sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-5 sm:px-4 ${lit ? "bg-sunken" : ""}`}>
                    <p className="text-sm leading-5 text-ink-soft"><span className="block font-semibold text-ink">Turn {line}</span>{me ? "You" : view.callerName}</p>
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap break-words text-[18px] leading-7 text-ink lg:text-[20px] lg:leading-[31px]">{t.text}</p>
                      {exact.length > 0 && <p data-cited="exact" className="mt-1 text-sm leading-5 text-ink-soft">Evidence for {exact.join(", ")}</p>}
                      {inexact.length > 0 && <p data-cited="inexact" className="mt-1 text-sm leading-5 text-ink-soft">{QUOTE_LABELS.citedInexact(inexact.join(", "))}</p>}
                      {cue && <p className="mt-1 text-sm leading-5 text-ink-soft">{CUE_LABELS[cue.type]} cue: {cue.title}{cue.used ? " (used)" : ""}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {ev && (
          <p className="mt-12 border-t border-line pt-4 text-sm leading-5 text-ink-soft">
            Graded by {graderLabel(ev)} · grader version {ev.graderVersion ?? "legacy"}{ev.evaluatedAt ? ` · graded ${new Date(ev.evaluatedAt).toLocaleString()}` : ""}. Evidence quotes were checked against the transcript when the grade was made.
          </p>
        )}
      </div>
    </div>
  );
}

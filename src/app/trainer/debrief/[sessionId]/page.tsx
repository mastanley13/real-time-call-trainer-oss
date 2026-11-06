"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getLocalSession, updateLocalEvaluation } from "@/lib/sessionStore";
import { listScenarios } from "@/lib/scenarioStore";
import type { Evaluation } from "@/lib/grader-types";
import { graderLabel, isLegacyGrader } from "@/lib/grader-types";
import { nextDrill, weakestCriterion } from "@/lib/debrief";
import { canRegrade, isAiGrade } from "@/lib/gradable";
import { canManageTeam } from "@/lib/team";
import { PageSkeleton } from "@/components/ui/Skeleton";
import DebriefReport, { DebriefState, turnId, type DebriefView } from "@/components/debrief/DebriefReport";
import { STATE_COPY, regradeErrorText } from "@/components/debrief/debriefCopy";

interface View extends DebriefView {
  role?: string;
  local: boolean;
  /** The trainee who made a server-stored call. */
  ownerId?: string;
}

type LoadError = "notFound" | "forbidden" | "notLocal" | "loadFailed";

export default function DebriefPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { isAuthenticated, isLoading, capabilities, user } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [regrading, setRegrading] = useState(false);
  const [regradeMsg, setRegradeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const regradeMsgRef = useRef<HTMLParagraphElement>(null);
  // After a successful re-grade the button is usually gone (the grade is now an AI grade), so focus moves to the message that says what happened.
  useEffect(() => { if (regradeMsg?.ok) regradeMsgRef.current?.focus(); }, [regradeMsg]);

  useEffect(() => {
    if (!capabilities || isLoading) return;
    if (sessionId.startsWith("local-")) {
      const s = getLocalSession(sessionId);
      if (!s) { setError("notLocal"); return; }
      setView({ title: s.scenario.title, scenario: s.scenario, scenarioId: s.scenario.id, role: s.scenario.role, createdAt: s.createdAt, durationSeconds: s.durationSeconds, transcript: s.transcript, evaluation: s.evaluation, callerName: s.scenario.aiPersona.name, coach: s.coach, local: true });
      return;
    }
    if (!isAuthenticated) { router.replace("/login"); return; }
    // The voice label comes from its own route so the session view stays an exact allowlist. It is optional:
    // a failed lookup only hides the label.
    const voice: Promise<"premium" | "standard" | null> = fetch(`/api/transcripts/${encodeURIComponent(sessionId)}/voice`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d?.voiceUsed === "premium" || d?.voiceUsed === "standard" ? d.voiceUsed : null))
      .catch(() => null);
    fetch(`/api/transcripts/${encodeURIComponent(sessionId)}`)
      .then(async (r) => {
        if (!r.ok) { setError(r.status === 404 ? "notFound" : r.status === 403 ? "forbidden" : "loadFailed"); return; }
        const { session } = await r.json();
        const sc = listScenarios().find((x) => x.id === session.scenarioId);
        setView({
          title: session.scenarioTitle ?? session.scenarioId, scenario: sc, scenarioId: session.scenarioId, role: sc?.role, createdAt: session.createdAt,
          durationSeconds: session.durationSeconds, transcript: Array.isArray(session.transcript) ? session.transcript : [], evaluation: session.evaluation ?? null,
          supervisorNotes: session.supervisorNotes, callerName: sc?.aiPersona.name ?? "Caller", local: false, ownerId: session.userId, voiceUsed: await voice,
        });
      })
      .catch(() => setError("loadFailed"));
  }, [sessionId, capabilities, isLoading, isAuthenticated, router]);

  const ev = view?.evaluation ?? null;
  const drill = useMemo(() => {
    const weakest = ev && weakestCriterion(ev);
    return view && weakest ? nextDrill(listScenarios(), { id: view.scenarioId, role: view.role }, weakest.name) : undefined;
  }, [view, ev]);

  function jump(line: number) {
    setFocus(line);
    const el = document.getElementById(turnId(line));
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    // Move focus too, so keyboard and screen reader users land on the line they asked for.
    el?.focus({ preventScroll: true });
    history.replaceState(null, "", `#${turnId(line)}`);
  }

  async function regrade() {
    if (!view?.scenario || regrading) return;
    setRegrading(true);
    setRegradeMsg(null);
    const headers = { "Content-Type": "application/json" };
    try {
      // Browser sessions are graded here and saved locally. Server sessions are graded by the server from the
      // transcript it stored, and it saves the result; the scenario is sent only for custom personas it lacks.
      const res = view.local
        ? await fetch("/api/evaluate-call", { method: "POST", headers, body: JSON.stringify({ scenario: view.scenario, transcript: view.transcript }) })
        : await fetch(`/api/transcripts/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers, body: JSON.stringify({ scenario: view.scenario }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Re-grading failed. Try again in a minute.");
      const next: Evaluation = view.local ? data : data.evaluation;
      // The grader falls back to rules when the model call fails; keep the current grade instead of swapping in another estimate.
      if (next?.method !== "llm") throw new Error("AI grading didn't work this time, so your grade wasn't changed. Try again in a minute.");
      if (view.local) updateLocalEvaluation(sessionId, next);
      setView({ ...view, evaluation: next });
      setRegradeMsg({ ok: true, text: `Re-graded by ${graderLabel(next)}.` });
    } catch (e) {
      // A server message can name a setting; the rep gets a plain sentence instead.
      setRegradeMsg({ ok: false, text: e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : regradeErrorText(e instanceof Error ? e.message : "Re-grading failed.") });
    } finally {
      setRegrading(false);
    }
  }

  if (error && !view) {
    const s = STATE_COPY[error];
    return <div className="focus-strong site-wrap py-8 text-base leading-6 lg:py-12"><DebriefState {...s} href={error === "notLocal" ? "/trainer" : "/dashboard"} headingLevel={1} /></div>;
  }
  if (!view) return <PageSkeleton rows={2} />;

  const heuristic = ev && (ev.method !== "llm" || isLegacyGrader(ev));
  // Browser sessions re-grade a rules-based grade only. Server sessions follow the PATCH rule: managers and admins
  // always, the trainee only while the call has no AI grade. The server checks again and its 403 shows below the button.
  const mayRegrade = view.local
    ? !!heuristic
    : canRegrade({ managesOrg: canManageTeam(user?.role, !!user?.isPlatformAdmin), ownsSession: !!user && view.ownerId === user.id }, ev);
  const aiGradeLocked = !view.local && !mayRegrade && isAiGrade(ev);
  const showButton = mayRegrade && !!view.scenario && !!capabilities?.llm;
  const lockedHint = aiGradeLocked && capabilities?.llm;
  const offHint = (heuristic || !ev) && capabilities && !capabilities.llm;
  const gradeControls = (showButton || lockedHint || offHint || regradeMsg) ? (
    <>
      {showButton && (
        <button type="button" className="btn-ghost btn-lg w-full" onClick={regrade} aria-disabled={regrading} aria-busy={regrading}>
          {regrading && <Loader2 size={16} strokeWidth={1.75} className="motion-safe:animate-spin" aria-hidden />} {regrading ? "Re-grading" : "Re-grade with AI"}
        </button>
      )}
      {lockedHint && <p className="text-sm leading-5 text-ink-soft">Think this grade is wrong? Ask your manager to re-grade it.</p>}
      {offHint && <p className="text-sm leading-5 text-ink-soft">AI grading is off on this server. <Link href="/settings/models" className="font-semibold text-primary underline underline-offset-4">See how to turn it on</Link></p>}
      {regradeMsg && <p ref={regradeMsgRef} tabIndex={-1} role={regradeMsg.ok ? "status" : "alert"} className={`text-sm leading-5 outline-none ${regradeMsg.ok ? "text-ok" : "text-alert"}`}>{regradeMsg.text}</p>}
    </>
  ) : null;

  return <DebriefReport sessionId={sessionId} view={view} drill={drill} focusLine={focus} onJump={jump} gradeControls={gradeControls} onPrint={() => window.print()} />;
}

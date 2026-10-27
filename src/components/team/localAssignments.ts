"use client";
/** Demo-mode assignment views: the browser store plus completion from browser-stored sessions. */
import { listLocalAssignments } from "@/lib/assignmentStore";
import { listLocalSessions } from "@/lib/sessionStore";
import { assignmentProgress, progressFor, sortForAssignee, teamIdsOf, toAssignmentView, type AssignmentView, type CompletionSession, type TeamMember } from "@/lib/team";

/** Sessions in this browser belong to whoever is using it, so they all count as the viewer's. */
export function localCompletion(viewerId: string): CompletionSession[] {
  return listLocalSessions().map((s) => ({ id: s.id, userId: viewerId, scenarioId: s.scenario.id, createdAt: s.createdAt }));
}

/** Manager view: every active assignment, with progress across the (sample) team. */
export function localTeamViews(members: TeamMember[], viewerId: string): AssignmentView[] {
  const sessions = localCompletion(viewerId);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const team = teamIdsOf(members);
  return listLocalAssignments().map((a) => toAssignmentView(a, names, assignmentProgress(a, sessions, team)));
}

/** "Assigned to you": the viewer's own and whole-team assignments, open ones first. */
export function localViewsFor(viewer: { id: string; name: string }): AssignmentView[] {
  const sessions = localCompletion(viewer.id);
  const names = new Map([[viewer.id, viewer.name]]);
  return sortForAssignee(
    listLocalAssignments()
      .filter((a) => !a.assigneeId || a.assigneeId === viewer.id)
      .map((a) => toAssignmentView(a, names, progressFor(a, viewer.id, sessions))),
  );
}

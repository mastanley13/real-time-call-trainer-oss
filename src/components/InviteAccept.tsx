"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import AuthShell from "@/components/AuthShell";
import { INVITE_ROLE_LABEL, isInviteToken, type InvitePreview } from "@/lib/invites";

type State =
  | { kind: "loading" }
  | { kind: "ready"; preview: InvitePreview }
  | { kind: "joined"; teamName: string }
  | { kind: "problem"; message: string };

const BAD_LINK = "This invite link is not valid. Check that you copied the whole link, or ask the team owner for a new one.";

/**
 * The invite landing page. Signed out: sign in or create an account, both coming back here. Signed in: the team's
 * name and one Accept button. The token is sent in request bodies only.
 */
export default function InviteAccept({ token }: { token: string }) {
  const { isAuthenticated, isLoading, capabilities, capabilitiesFailed, user, adoptSession, logout } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = isInviteToken(token);
  const here = `/invite/${token}`;
  const known = capabilities !== null || capabilitiesFailed;

  useEffect(() => {
    if (!valid || !isAuthenticated) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/invites/preview", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.status === 401) { setState({ kind: "problem", message: "Your session expired. Sign in again to see this invite." }); return; }
        if (!res.ok) { setState({ kind: "problem", message: body.message || BAD_LINK }); return; }
        setState({ kind: "ready", preview: body as InvitePreview });
      } catch {
        if (live) setState({ kind: "problem", message: "Your browser couldn't reach this server. Check your connection and reload." });
      }
    })();
    return () => { live = false; };
  }, [valid, isAuthenticated, token]);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invites/accept", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.message || "Could not accept the invite. Try again in a minute."); return; }
      // The server sent a new session with the new role; pick it up so the header and tabs match.
      if (!body.sample) await adoptSession().catch(() => {});
      setState({ kind: "joined", teamName: body.team?.name ?? "the team" });
    } catch {
      setError("Your browser couldn't reach this server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchAccount() {
    logout();
    router.push(`/login?next=${encodeURIComponent(here)}`);
  }

  if (!valid) {
    return <AuthShell title="Invite not found" subtitle={BAD_LINK}><Link href="/" className="btn-ghost w-full">Go to the home page</Link></AuthShell>;
  }

  if (!known || isLoading) {
    return (
      <AuthShell title="Team invite" subtitle="Checking your invite.">
        <p className="flex items-center gap-2 text-sm text-ink-soft" role="status"><Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> Loading</p>
      </AuthShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthShell title="You're invited to a team" subtitle="Sign in or create an account with the email address the invite was sent to. You'll come back here to accept.">
        <div className="space-y-3">
          <Link href={`/login?next=${encodeURIComponent(here)}`} className="btn-primary w-full">Sign in to accept</Link>
          <Link href={`/register?invite=${token}`} className="btn-ghost w-full">Create an account</Link>
        </div>
      </AuthShell>
    );
  }

  if (state.kind === "loading") {
    return (
      <AuthShell title="Team invite" subtitle="Checking your invite.">
        <p className="flex items-center gap-2 text-sm text-ink-soft" role="status"><Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> Loading</p>
      </AuthShell>
    );
  }

  if (state.kind === "problem") {
    return (
      <AuthShell title="This invite can't be used" subtitle={state.message}>
        <Link href="/trainer" className="btn-ghost w-full">Go to practice</Link>
      </AuthShell>
    );
  }

  if (state.kind === "joined") {
    return (
      <AuthShell title={`You joined ${state.teamName}`} subtitle="Your practice now counts toward the team, and you share its voice minutes.">
        <Link href="/trainer" className="btn-primary w-full">Start practising</Link>
      </AuthShell>
    );
  }

  const p = state.preview;
  if (p.alreadyMember) {
    return (
      <AuthShell title={`You're already on ${p.teamName}`} subtitle="There is nothing to accept.">
        <Link href="/trainer" className="btn-primary w-full">Go to practice</Link>
      </AuthShell>
    );
  }
  if (!p.emailMatches) {
    return (
      <AuthShell title="This invite is for another email" subtitle={`The invite to ${p.teamName} was sent to ${p.invitedEmail}. You're signed in as ${user?.email ?? "a different account"}.`}>
        <button type="button" className="btn-primary w-full" onClick={switchAccount}>Sign in with another account</button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${p.teamName}`} subtitle={`You've been invited as a ${INVITE_ROLE_LABEL[p.role].toLowerCase()}. The invite expires ${new Date(p.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`}>
      <div className="space-y-3">
        {p.sample && <p className="chip">Sample data: nothing is saved in demo mode</p>}
        <p className="text-sm text-ink-soft">{"Accepting moves your account to this team. If you're on another team now, you leave it."}</p>
        {error && <p role="alert" className="break-words text-sm text-alert">{error}</p>}
        <button type="button" className="btn-primary w-full" onClick={accept} disabled={busy} aria-busy={busy}>
          {busy && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {busy ? "Joining" : `Accept and join ${p.teamName}`}
        </button>
        <p className="text-xs text-ink-muted">Signed in as {user?.email}. <button type="button" className="font-semibold text-primary underline-offset-2 hover:underline" onClick={switchAccount}>Use another account</button></p>
      </div>
    </AuthShell>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, UserMinus, UserPlus } from "lucide-react";
import { ROLE_LABEL, type TeamRole } from "@/lib/team";

/**
 * Who reports to whom. Owners set roles and move reps between managers;
 * managers claim reps who have no manager yet and release their own.
 * Also shows the invite link that drops new reps onto the viewer's team.
 */

interface Member { id: string; name: string; role: TeamRole; managerId: string | null; joinedAt: string; lastLoginAt: string | null }
interface Payload { organization: { name: string; code: string | null } | null; canEditRoles: boolean; members: Member[] }

export interface Lead { id: string; name: string }

export default function MembersPanel({ viewerId, onChanged, onLeads }: { viewerId: string; onChanged: () => void; onLeads?: (managers: Lead[]) => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/team/members", { credentials: "include" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message || "Could not load your team members. Refresh the page to try again.");
        if (live) { setData(body as Payload); setError(""); }
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [reload]);

  const leads = useMemo(() => (data?.members ?? []).filter((m) => m.role === "manager" || m.role === "owner"), [data]);
  const nameOf = useMemo(() => new Map((data?.members ?? []).map((m) => [m.id, m.name])), [data]);
  const viewer = data?.members.find((m) => m.id === viewerId);
  useEffect(() => {
    if (data?.canEditRoles) onLeads?.(data.members.filter((m) => m.role === "manager").map((m) => ({ id: m.id, name: m.name })));
  }, [data, onLeads]);

  async function change(id: string, body: { role?: "trainee" | "manager"; managerId?: string | null }) {
    setBusyId(id);
    setError("");
    try {
      const r = await fetch(`/api/team/members?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.message || "Could not save that change. Try again.");
      setReload((n) => n + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that change.");
    } finally {
      setBusyId(null);
    }
  }

  const invite = data?.organization?.code && typeof window !== "undefined"
    ? `${window.location.origin}/register?code=${data.organization.code}${viewer?.role === "manager" ? `&manager=${viewerId}` : ""}`
    : "";

  async function copy() {
    try { await navigator.clipboard.writeText(invite); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* shown to copy by hand */ }
  }

  return (
    <section className="panel overflow-hidden" aria-labelledby="members-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <h2 id="members-h" className="text-sm font-bold">Members and managers</h2>
        {data?.organization?.code && <p className="font-mono text-[11px] text-ink-muted">team code {data.organization.code}</p>}
      </div>

      {invite && (
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <p className="text-sm text-ink-soft">
            {viewer?.role === "manager" ? "Reps who sign up with this link join your team." : "Reps who sign up with this link join the organization. Place them under a manager below."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="mono min-w-0 flex-1 break-all rounded-lg bg-sunken px-3 py-2 text-xs">{invite}</code>
            <button type="button" className="btn-ghost btn-sm" onClick={copy}><Copy size={14} strokeWidth={1.75} aria-hidden /> {copied ? "Copied" : "Copy invite link"}</button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="banner-warn m-4">{error}</p>}
      {!data && !error && <p className="px-4 py-3 text-sm text-ink-muted sm:px-5">Loading members…</p>}

      {data && (
        <ul className="divide-y divide-line">
          {data.members.map((m) => {
            const self = m.id === viewerId;
            const busy = busyId === m.id;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.name}{self && <span className="font-normal text-ink-muted"> (you)</span>}</p>
                  <p className="text-xs text-ink-muted">
                    {ROLE_LABEL[m.role]}
                    {m.role !== "owner" && (m.managerId ? ` · reports to ${nameOf.get(m.managerId) ?? "a manager"}` : m.role === "trainee" ? " · no manager yet" : "")}
                  </p>
                </div>

                {data.canEditRoles && !self && m.role !== "owner" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${m.id}`}>Role for {m.name}</label>
                    <select id={`role-${m.id}`} className="input !h-9 !w-auto !py-1 text-sm" value={m.role} disabled={busy}
                      onChange={(e) => change(m.id, { role: e.target.value as "trainee" | "manager" })}>
                      <option value="trainee">Rep</option>
                      <option value="manager">Manager</option>
                    </select>
                    <label className="sr-only" htmlFor={`mgr-${m.id}`}>Manager for {m.name}</label>
                    <select id={`mgr-${m.id}`} className="input !h-9 !w-auto !py-1 text-sm" value={m.managerId ?? ""} disabled={busy}
                      onChange={(e) => change(m.id, { managerId: e.target.value || null })}>
                      <option value="">No manager</option>
                      {leads.filter((l) => l.id !== m.id && (m.role !== "manager" || l.role === "owner")).map((l) => (
                        <option key={l.id} value={l.id}>{l.name}{l.role === "owner" ? " (owner)" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}

                {!data.canEditRoles && m.role === "trainee" && (
                  m.managerId === viewerId ? (
                    <button type="button" className="btn-quiet btn-sm" disabled={busy} onClick={() => change(m.id, { managerId: null })}>
                      <UserMinus size={14} strokeWidth={1.75} aria-hidden /> Remove from my team
                    </button>
                  ) : !m.managerId ? (
                    <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => change(m.id, { managerId: viewerId })}>
                      <UserPlus size={14} strokeWidth={1.75} aria-hidden /> Add to my team
                    </button>
                  ) : null
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

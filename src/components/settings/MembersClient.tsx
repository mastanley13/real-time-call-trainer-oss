"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  INVITE_ROLE_LABEL, INVITE_ROLES, MAX_INVITES_PER_REQUEST, looksLikeEmail, parseEmailList, payloadSeats, seatSummary, seatsFullLead, sortInvites,
  type InviteRole, type InviteView, type MembersPayload,
} from "@/lib/invites";
import { ROLE_LABEL } from "@/lib/team";
import InviteLinks, { type IssuedLink } from "./InviteLinks";
import SettingsNav from "./SettingsNav";

type Confirm = { kind: "revoke"; invite: InviteView } | { kind: "remove"; id: string; name: string };

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function MembersClient() {
  const { isAuthenticated, isLoading, capabilities } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  // Demo mode only: ?demo=full shows the sample team with every seat taken. The server ignores it otherwise.
  const demo = params.get("demo") === "full" ? "?demo=full" : "";
  const [data, setData] = useState<MembersPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Problems with what was typed in the email box, shown under it. */
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [seatsFullAt, setSeatsFullAt] = useState<number | null>(null);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<InviteRole>("trainee");
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [links, setLinks] = useState<IssuedLink[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const linksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (capabilities && !isLoading && !isAuthenticated) router.replace("/login?next=/settings/members");
  }, [capabilities, isLoading, isAuthenticated, router]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/team/members${demo}`, { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not load your team. Reload the page to try again.");
      setData(body as MembersPayload);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof TypeError ? "Your browser couldn't reach this server. Check your connection and reload." : e instanceof Error ? e.message : "Could not load your team.");
    }
  }, [demo]);
  useEffect(() => { if (isAuthenticated) void load(); }, [isAuthenticated, load]);

  // New links scroll into view (a jump when motion is reduced) so the person sees what to copy.
  useEffect(() => {
    if (!links.length || !linksRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    linksRef.current.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [links]);

  /** Runs one mutation at a time. Returns the parsed body on success, or null after showing the error. */
  async function send(key: string, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    if (busyRef.current) return null;
    busyRef.current = key;
    setBusy(key);
    setError(null);
    setSeatsFullAt(null);
    try {
      const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.error === "seats_full") {
        setSeatsFullAt(typeof body.seats === "number" ? body.seats : data?.org.seatCount ?? 0);
        return null;
      }
      if (!res.ok) {
        setError(body.message || "That didn't work. Reload the page and try again.");
        return null;
      }
      return body;
    } catch {
      setError("Your browser couldn't reach this server. Check your connection and try again.");
      return null;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }

  /** Applies a local change and recomputes the seat summary from the lists. */
  function update(change: (d: MembersPayload) => Pick<MembersPayload, "members" | "invites">) {
    setData((d) => {
      if (!d) return d;
      const next = { ...d, ...change(d) };
      return { ...next, invites: sortInvites(next.invites), seats: payloadSeats(next) };
    });
  }

  const parsed = parseEmailList(emails);
  const invalid = parsed.filter((e) => !looksLikeEmail(e));

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    const problem = !parsed.length ? "Enter at least one email address."
      : invalid.length ? `Check ${invalid.length === 1 ? "this address" : "these addresses"}: ${invalid.join(", ")}`
      : parsed.length > MAX_INVITES_PER_REQUEST ? `Invite up to ${MAX_INVITES_PER_REQUEST} people at a time.`
      : null;
    setFieldError(problem);
    if (problem) return;
    const body = await send("invite", `/api/team/invites${demo}`, { method: "POST", body: JSON.stringify({ emails: parsed, role }) });
    if (!body) return;
    const created = body.invites as (InviteView & { link: string })[];
    update((d) => ({ members: d.members, invites: [...created.map(({ id, email, role, status, sentAt, expiresAt }) => ({ id, email, role, status, sentAt, expiresAt })), ...d.invites] }));
    setLinks(created.map((c) => ({ email: c.email, link: c.link })));
    setEmails("");
  }

  async function onResend(invite: InviteView) {
    const body = await send(`resend:${invite.id}`, `/api/team/invites/${encodeURIComponent(invite.id)}/resend${demo}`, { method: "POST", body: "{}" });
    if (!body) return;
    const fresh = body.invite as InviteView;
    update((d) => ({ members: d.members, invites: d.invites.map((i) => (i.id === fresh.id ? fresh : i)) }));
    setLinks([{ email: fresh.email, link: body.link as string }]);
  }

  async function onConfirm() {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === "revoke") {
      const ok = await send(`revoke:${c.invite.id}`, `/api/team/invites/${encodeURIComponent(c.invite.id)}${demo}`, { method: "DELETE" });
      if (ok) {
        update((d) => ({ members: d.members, invites: d.invites.filter((i) => i.id !== c.invite.id) }));
        setLinks((l) => l.filter((x) => x.email !== c.invite.email));
      }
    } else {
      const ok = await send(`remove:${c.id}`, `/api/team/members/${encodeURIComponent(c.id)}${demo}`, { method: "DELETE" });
      if (ok) update((d) => ({ members: d.members.filter((m) => m.id !== c.id), invites: d.invites }));
    }
  }

  if (!capabilities || !isAuthenticated || (!data && !loadError)) return <PageSkeleton rows={3} />;

  if (!data) {
    return (
      <div className="page enter max-w-5xl space-y-6">
        <SettingsNav />
        <header>
          <p className="eyebrow">Settings</p>
          <h1 className="mt-1 text-3xl font-bold">Members</h1>
        </header>
        <p className="banner-warn" role="alert">{loadError}</p>
      </div>
    );
  }

  const manage = data.access === "manage";
  const { used, total } = data.seats;
  const full = used >= total;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 100;
  const owners = data.members.filter((m) => m.role === "owner").length;
  const pending = data.invites.filter((i) => i.status === "pending").length;
  const fullCount = seatsFullAt ?? (manage && full ? total : null);

  return (
    <div className="page enter max-w-5xl space-y-6">
      <SettingsNav />
      <header>
        <p className="eyebrow">Settings</p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold">Members</h1>
          {data.sample && <span className="chip">Sample data</span>}
        </div>
        <p className="mt-2 max-w-2xl text-ink-soft">
          People on {data.org.name}. Each member and each pending invite takes one seat.
          {data.sample && " Demo mode: changes here are not saved."}
        </p>
      </header>

      {data.access === "not_team_plan" && (
        <p className="banner-warn" role="status">
          Inviting people needs the Team plan.{" "}
          <Link href="/settings/billing" className="font-semibold underline underline-offset-2">Go to Billing</Link>
        </p>
      )}
      {data.access === "view" && <p className="rounded-lg border border-line bg-sunken p-3 text-sm text-ink">Only an owner of this team can invite or remove people.</p>}

      <section className="panel p-4 sm:p-5" aria-labelledby="seats-h">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="seats-h" className="text-lg font-bold">Seats</h2>
          {manage && <Link href="/settings/billing" className="text-sm font-semibold text-primary underline-offset-2 hover:underline">Change seats in Billing</Link>}
        </div>
        <p className="mt-3 text-2xl font-bold tabular-nums">{seatSummary(used, total)}</p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${used} of ${total} seats used`}>
          <div className={`h-full ${full ? "bg-caution" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-sm text-ink-soft tabular-nums">
          {data.members.length} {data.members.length === 1 ? "member" : "members"}, {pending} pending {pending === 1 ? "invite" : "invites"}. {"Expired invites don't take a seat."}
        </p>
      </section>

      {fullCount !== null && (
        <p className="banner-warn" role={seatsFullAt !== null ? "alert" : "status"}>
          {seatsFullLead(fullCount)}{" "}
          <Link href="/settings/billing" className="font-semibold underline underline-offset-2">Add seats from Billing</Link> to invite more people.
        </p>
      )}
      {error && <p className="banner-warn break-words" role="alert">{error}</p>}

      {manage && (
        <section className="panel p-4 sm:p-5" aria-labelledby="invite-h">
          <h2 id="invite-h" className="text-lg font-bold">Invite people</h2>
          <form onSubmit={onInvite} className="mt-3 space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div>
                <label htmlFor="invite-emails" className="label">Email addresses</label>
                <textarea
                  id="invite-emails" name="emails" className="input min-h-[44px] resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" rows={2}
                  placeholder="name@company.com, another@company.com"
                  autoComplete="off" spellCheck={false} autoCapitalize="none"
                  value={emails} onChange={(e) => { setEmails(e.target.value); setFieldError(null); }}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? "invite-error invite-help" : "invite-help"} disabled={full || !!busy}
                />
                {fieldError && <p id="invite-error" role="alert" className="mt-1 break-words text-sm text-alert">{fieldError}</p>}
              </div>
              <div>
                <label htmlFor="invite-role" className="label">Role</label>
                <select id="invite-role" name="role" className="input focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" value={role} onChange={(e) => setRole(e.target.value as InviteRole)} disabled={full || !!busy}>
                  {INVITE_ROLES.map((r) => <option key={r} value={r}>{INVITE_ROLE_LABEL[r]}</option>)}
                </select>
              </div>
            </div>
            <p id="invite-help" className="text-xs text-ink-muted">
              Separate addresses with commas or new lines, up to {MAX_INVITES_PER_REQUEST} at a time. Each person gets a link to share with them. Links expire after 7 days. No email is sent.
            </p>
            <button type="submit" className="btn-primary" disabled={full || !!busy}>
              {busy === "invite" ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <UserPlus size={16} strokeWidth={1.75} aria-hidden />}
              {parsed.length > 1 ? `Invite ${parsed.length} people` : "Invite member"}
            </button>
          </form>
        </section>
      )}

      {links.length > 0 && <InviteLinks ref={linksRef} links={links} onDone={() => setLinks([])} />}

      <section className="panel p-4 sm:p-5" aria-labelledby="invites-h">
        <h2 id="invites-h" className="text-lg font-bold">Pending invites <span className="font-normal text-ink-muted tabular-nums">({data.invites.length})</span></h2>
        {data.invites.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No open invites.{manage && !full ? " Invite someone above to get started." : ""}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate font-medium" title={i.email}>{i.email}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                      <span className={`lamp ${i.status === "pending" ? "lamp-ok" : "lamp-caution"}`} aria-hidden />
                      {i.status === "pending" ? "Pending" : "Expired"}
                    </span>
                    <span>{i.status === "pending" ? `Expires ${fmtDate(i.expiresAt)}` : `Expired ${fmtDate(i.expiresAt)}`}</span>
                    <span>{INVITE_ROLE_LABEL[i.role]}</span>
                  </p>
                </div>
                {manage && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => onResend(i)} disabled={!!busy || (i.status === "expired" && full)} aria-label={`Resend invite to ${i.email}`}>
                      {busy === `resend:${i.id}` ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <RotateCw size={14} strokeWidth={1.75} aria-hidden />}
                      Resend
                    </button>
                    <button type="button" className="btn-quiet btn-sm" onClick={() => setConfirm({ kind: "revoke", invite: i })} disabled={!!busy} aria-label={`Revoke invite to ${i.email}`}>
                      <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel p-4 sm:p-5" aria-labelledby="members-h">
        <h2 id="members-h" className="text-lg font-bold">Active members <span className="font-normal text-ink-muted tabular-nums">({data.members.length})</span></h2>
        <ul className="mt-3 divide-y divide-line">
          {data.members.map((m) => {
            const you = m.id === data.viewerId;
            const lastOwner = m.role === "owner" && owners <= 1;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="min-w-0 max-w-full truncate">{m.name}</span>
                    {you && <span className="chip">You</span>}
                  </p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-muted">
                    <span className="min-w-0 max-w-full truncate" title={m.email}>{m.email}</span>
                    <span>{ROLE_LABEL[m.role]}</span>
                    <span>Joined {fmtDate(m.joinedAt)}</span>
                  </p>
                </div>
                {manage && !you && !lastOwner && (
                  <button type="button" className="btn-quiet btn-sm" onClick={() => setConfirm({ kind: "remove", id: m.id, name: m.name })} disabled={!!busy} aria-label={`Remove ${m.name} from the team`}>
                    {busy === `remove:${m.id}` ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <UserMinus size={14} strokeWidth={1.75} aria-hidden />}
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "revoke" ? "Revoke invite?" : `Remove ${confirm.name}?`}
          message={confirm.kind === "revoke"
            ? `The link for ${confirm.invite.email} stops working and its seat is freed.`
            : "They keep their account and past calls stay with the team, but they lose access to the team and its voice minutes. Their seat is freed."}
          confirmLabel={confirm.kind === "revoke" ? "Revoke invite" : "Remove member"}
          onConfirm={onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

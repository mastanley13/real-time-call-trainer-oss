"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { MAX_GRACE_DAYS, type MfaState } from "@/lib/mfaPolicy";

interface MfaMember { id: string; name: string; role: string; mfaEnabled: boolean; mfaEnrolledAt: string | null; state: MfaState }
interface MfaData { requireMfa: boolean; graceEndsAt: string | null; canEnforce: boolean; members: MfaMember[] }

const GRACE_CHOICES = [0, 7, 14, MAX_GRACE_DAYS];

function statusChip(m: MfaMember) {
  if (m.mfaEnabled) return <span className="chip !border-ok/40 !text-ok"><Check size={12} strokeWidth={1.75} aria-hidden />Enrolled</span>;
  if (m.state === "grace") return <span className="chip !border-caution/40">Needs MFA, in grace period</span>;
  if (m.state === "enroll_required") return <span className="chip !border-alert/40">Must enrol at next sign-in</span>;
  return <span className="chip">Not enrolled</span>;
}

/** Manager view of the org MFA rule: the switch (Team plan), an optional grace period, each member's status and a support reset. */
export default function MfaPanel({ viewerId }: { viewerId: string }) {
  const [data, setData] = useState<MfaData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [graceDays, setGraceDays] = useState(0);
  const [reset, setReset] = useState<MfaMember | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/team/mfa");
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Could not load MFA status. Refresh the page to try again.");
      setData(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load MFA status. Refresh the page to try again.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setRequired(requireMfa: boolean) {
    setBusy(true);
    setStatus("");
    try {
      const r = await fetch("/api/team/mfa", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireMfa, ...(requireMfa && graceDays ? { graceDays } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Could not change the MFA rule. Try again.");
      setStatus(requireMfa ? "MFA is now required for your team." : "MFA is no longer required.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the MFA rule. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doReset() {
    const target = reset;
    setReset(null);
    if (!target) return;
    setBusy(true);
    try {
      const r = await fetch("/api/team/mfa/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: target.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Could not reset MFA. Try again.");
      setStatus(`Reset MFA for ${target.name}.`);
      setError("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset MFA. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const enrolled = data?.members.filter((m) => m.mfaEnabled).length ?? 0;

  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="mfa-h">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="mfa-h" className="flex items-center gap-2 text-sm font-bold"><ShieldCheck size={16} strokeWidth={1.75} aria-hidden />Multi-factor authentication</h2>
        {data && <p className="font-mono text-[11px] text-ink-muted">{enrolled} of {data.members.length} enrolled</p>}
      </div>
      {error && <p className="banner-warn mb-3" role="alert">{error}</p>}
      <div role="status" aria-live="polite">{status && <p className="mb-3 text-sm text-ink-soft">{status}</p>}</div>
      {!data && !error && <Skeleton className="h-24 w-full" />}
      {data && (
        <>
          {data.requireMfa ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-soft">
                MFA is required.{" "}
                {data.graceEndsAt ? `Grace period ends ${new Date(data.graceEndsAt).toLocaleDateString()}.` : "Members without it must enrol at their next sign-in."}
              </p>
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => setRequired(false)}>Stop requiring MFA</button>
            </div>
          ) : data.canEnforce ? (
            <div className="flex flex-wrap items-end gap-3">
              <p className="min-w-[14rem] flex-1 text-sm text-ink-soft">Require every member to use an authenticator app. Members without one are sent to enrol when they sign in.</p>
              <div>
                <label htmlFor="mfa-grace" className="label">Grace period</label>
                <select id="mfa-grace" className="input" value={graceDays} onChange={(e) => setGraceDays(Number(e.target.value))}>
                  {GRACE_CHOICES.map((d) => <option key={d} value={d}>{d ? `${d} days` : "None"}</option>)}
                </select>
              </div>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => setRequired(true)}>Require MFA</button>
            </div>
          ) : (
            <p className="text-sm text-ink-soft">Requiring MFA is part of the Team plan. Upgrade to turn it on for your organization.</p>
          )}

          <ul className="mt-4 divide-y divide-line border-t border-line">
            {data.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="min-w-0 break-words text-sm font-medium">{m.name} <span className="font-normal text-ink-muted">· {m.role}</span></span>
                <span className="flex items-center gap-2">
                  {statusChip(m)}
                  {m.mfaEnabled && m.id !== viewerId && (
                    <button type="button" className="btn-quiet btn-sm" disabled={busy} onClick={() => setReset(m)} aria-label={`Reset MFA for ${m.name}`}>Reset</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {reset && (
        <ConfirmDialog title="Reset MFA?" confirmLabel="Reset"
          message={`${reset.name} loses their current authenticator and has to set up a new one${data?.requireMfa ? " before they can practise again" : ""}.`}
          onConfirm={doReset} onCancel={() => setReset(null)} />
      )}
    </section>
  );
}

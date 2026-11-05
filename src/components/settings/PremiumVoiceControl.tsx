"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Lock, Sparkles } from "lucide-react";
import { PREMIUM_CALL_LENGTH_NOTE, PREMIUM_COMING_SOON, PREMIUM_MINUTES, premiumAnnualNote, premiumDisclosure, premiumPriceLine } from "@/lib/pricing";
import { ADD_PREMIUM_LABEL, PREMIUM_NEEDS_GRADED_CALL, formatCents, formatResetDate, premiumFallbackLine, premiumLeftLabel } from "@/lib/billingUi";
import { trackPremiumUpsell } from "@/lib/premiumEventTypes";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/usagePlan";

/** What the add-on row needs from /api/usage. All optional so an older or partial answer still renders. */
export interface PremiumControlUsage {
  metered?: boolean;
  plan?: "free" | "pro" | "team";
  premiumVoice?: { enabled?: boolean; configured?: boolean; minutesCap?: number; remaining?: number; canBuy?: boolean; canManage?: boolean; offerReady?: boolean; removeAt?: string | null };
  billing?: { enabled?: boolean; seats?: number; seatsAtRenewal?: number | null; hasSubscription?: boolean; renewsAt?: string | null; status?: string | null };
}

/** Shown on the add-on row while the plan is in a Stripe trial: paid Premium is not part of a trial (Triage B2). */
export const PREMIUM_AFTER_TRIAL = "Premium voice can be added once your trial ends and your plan is active.";

/**
 * The seat stepper's text. It starts at the current seat count (a real value, not a placeholder, so ArrowUp on 3 gives
 * 4), follows a new server count while the owner has not typed anything, and never overwrites what they typed when the
 * usage data is fetched again (Prism finding 6).
 */
export function nextSeatsText(state: { text: string; edited: boolean }, serverSeats: number): { text: string; edited: boolean } {
  return state.edited ? state : { text: String(serverSeats), edited: false };
}

interface Preview { token: string; dueNow: number; renewalTotal: number | null; currency: string; interval: "month" | "year"; renewsAt: string | null; quantity: number; direction?: "up" | "down"; effectiveAt?: string | null }

const per = (i: "month" | "year") => (i === "year" ? "year" : "month");
const PLAN_NAME = { free: "Free", pro: "Pro", team: "Team" } as const;

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { message: "Could not reach the server. Check your connection and try again." } };
  }
}

/**
 * A review step before any billing change: when it takes effect, what it costs, what changes, then Back or Confirm.
 * Pattern reference (layout only, not copy): Square plan-change review modal,
 * https://mobbin.com/screens/c1b701da-2166-4b48-ae96-aea5ca5a4355 (explicit effective date, separated consequence
 * sections, back and next actions). Rendered inline in the panel, with the app's own tokens and Lucide icons.
 */
function Review({ id, title, rows, changes, confirmLabel, danger, busy, onBack, onConfirm }: {
  id: string;
  title: string;
  rows: [string, string][];
  changes: string[];
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus moves to the review so keyboard and screen reader users land on what they are confirming.
  useEffect(() => { headingRef.current?.focus(); }, []);
  return (
    <div className="rounded-panel border border-line bg-surface p-3 sm:p-4" role="group" aria-labelledby={id}>
      <h3 id={id} ref={headingRef} tabIndex={-1} className="font-heading text-base font-bold outline-none">{title}</h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="mono min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 border-t border-line pt-3">
        <p className="label">What changes</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          {changes.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-ghost btn-sm" onClick={onBack} disabled={busy}>
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />Back
        </button>
        <button type="button" className={`${danger ? "btn-danger" : "btn-primary"} btn-sm`} onClick={onConfirm} disabled={busy}>
          {busy && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * The Premium voice add-on row on /settings/billing, outside the plan purchase section so it shows in every billing state.
 *
 * Layout reference (structure only, not copy): incident.io billing overview,
 * https://mobbin.com/screens/10be17e8-dee3-43e3-8957-3d70f770fffd : the current plan and seat summary sits above the
 * add-on option in one restrained panel, and Premium is a small row, never an extra pricing card.
 *
 * Off sale (the default): a plain "Coming soon" line and no buy controls, unless the account already has the add-on; then
 * its state and Remove at period end still show (the sale gate controls purchases, not removal), and paid Premium is not
 * used at mint until the sale opens. On sale, for a Pro subscriber or a Team owner with a subscription: Add Premium voice
 * opens a review with the prorated charge today, the new renewal total and its date, and nothing changes until Confirm.
 */
export default function PremiumVoiceControl({ usage = null, onSale = false, onChanged }: { usage?: PremiumControlUsage | null; onSale?: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const serverSeats = usage?.billing?.seats ?? 1;
  const [seatsState, setSeatsState] = useState(() => nextSeatsText({ text: "", edited: false }, serverSeats));
  // A refetch with a new seat count updates the stepper only while the owner has not typed (nextSeatsText).
  useEffect(() => { setSeatsState((s) => nextSeatsText(s, serverSeats)); }, [serverSeats]);
  const seatsText = seatsState.text;
  const [seatPreview, setSeatPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);
  // Back from a review puts focus back on the control that opened it (Prism finding 5), not on the page body.
  const addRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const seatsRef = useRef<HTMLButtonElement>(null);
  const [returnFocus, setReturnFocus] = useState<"add" | "remove" | "seats" | null>(null);
  useEffect(() => {
    if (!returnFocus) return;
    ({ add: addRef, remove: removeRef, seats: seatsRef })[returnFocus].current?.focus();
    setReturnFocus(null);
  }, [returnFocus]);

  const p = usage?.premiumVoice;
  const plan = usage?.plan;
  const paid = plan === "pro" || plan === "team";
  // Buying needs the server's canBuy (right person, first graded call done, not in a Stripe trial); removal and seat
  // changes need only canManage (older answers without it fall back to canBuy).
  const hasSub = !!usage?.billing?.hasSubscription && paid;
  const canBuy = !!p?.canBuy && hasSub;
  const canManage = !!(p?.canManage ?? p?.canBuy) && hasSub;
  const enabled = !!p?.enabled;
  const configured = !!p?.configured;
  const offer = onSale && paid && !configured;
  const trialing = usage?.billing?.status === "trialing";
  const needsGrade = p?.offerReady === false;
  const unit = plan === "team" ? "team" : "pro";
  useEffect(() => { if (offer && canBuy) trackPremiumUpsell("billing"); }, [offer, canBuy]);

  async function run(kind: string, fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setError(null);
    setDone(null);
    try { await fn(); } finally { busyRef.current = false; setBusy(null); }
  }

  const previewAdd = () => run("preview", async () => {
    const r = await post("/api/billing/premium", { action: "preview" });
    if (!r.ok) { setError(String(r.data.message ?? "Could not price Premium voice right now. Nothing changed.")); return; }
    setPreview(r.data as unknown as Preview);
  });
  const confirmAdd = () => run("confirm", async () => {
    if (!preview) return;
    const r = await post("/api/billing/premium", { action: "confirm", token: preview.token });
    if (!r.ok) { setError(String(r.data.message ?? "Premium voice was not added. Nothing was charged.")); setPreview(null); return; }
    setPreview(null);
    setDone("Premium voice is on. Your next call uses it.");
    onChanged?.();
  });
  const remove = () => run("remove", async () => {
    const r = await post("/api/billing/premium", { action: "remove" });
    if (!r.ok) { setError(String(r.data.message ?? "Could not schedule the removal. Nothing changed.")); return; }
    setConfirmRemove(false);
    setDone(premiumFallbackLine(typeof r.data.removeAt === "string" ? r.data.removeAt : null));
    onChanged?.();
  });
  const seatsWanted = () => Math.floor(Number(seatsText.trim()));
  const previewSeats = () => run("seats", async () => {
    const seats = seatsWanted();
    if (!Number.isFinite(seats) || seats < TEAM_MIN_SEATS || seats > TEAM_MAX_SEATS) { setError(`Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.`); return; }
    const r = await post("/api/billing/seats", { action: "preview", seats });
    if (!r.ok) { setError(String(r.data.message ?? "Could not price that seat change. Nothing changed.")); return; }
    setSeatPreview(r.data as unknown as Preview);
  });
  const confirmSeats = () => run("seats-confirm", async () => {
    if (!seatPreview) return;
    const r = await post("/api/billing/seats", { action: "confirm", seats: seatPreview.quantity, token: seatPreview.token });
    if (!r.ok) { setError(String(r.data.message ?? "Seats did not change. Nothing was charged.")); setSeatPreview(null); return; }
    setSeatPreview(null);
    // Done: the stepper follows the server's seat count again.
    setSeatsState({ text: String(seatPreview.quantity), edited: false });
    setDone(r.data.direction === "down"
      ? `Seats drop to ${seatPreview.quantity} on ${formatResetDate(seatPreview.effectiveAt ?? undefined) || "your renewal date"}.`
      : `You now have ${seatPreview.quantity} seats.`);
    onChanged?.();
  });

  // Off sale and nothing on the account: the plain label, as before. No buy controls.
  if (!onSale && !configured) {
    return <p className="panel p-4 text-sm text-ink-muted">Premium AI voice: {PREMIUM_COMING_SOON}</p>;
  }

  const seats = serverSeats;
  const renews = formatResetDate(usage?.billing?.renewsAt ?? undefined);
  const teamOwner = plan === "team" && canManage;
  const status = enabled ? "On" : configured ? (onSale ? "Paused" : "Not available yet") : "Not added";
  return (
    <section className="panel space-y-4 p-4 sm:p-5" aria-labelledby="premium-h">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} strokeWidth={1.75} className="text-primary" aria-hidden />
        <h2 id="premium-h" className="text-lg font-bold">Premium voice</h2>
        <span className="chip">{status}</span>
      </div>

      {/* Current plan and seat summary first, then the add-on row. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-panel bg-sunken p-3 text-sm">
        <dt className="text-ink-muted">Plan</dt>
        <dd>{PLAN_NAME[plan ?? "free"]}</dd>
        {plan === "team" && (
          <>
            <dt className="text-ink-muted">Seats</dt>
            <dd>
              <span className="mono">{seats}</span>
              {usage?.billing?.seatsAtRenewal ? <> · drops to <span className="mono">{usage.billing.seatsAtRenewal}</span> on {renews || "your renewal date"}</> : null}
            </dd>
          </>
        )}
        <dt className="text-ink-muted">Premium</dt>
        <dd>{enabled && p ? premiumLeftLabel({ remaining: p.remaining ?? 0, cap: p.minutesCap ?? 0 }) : status}</dd>
        {paid && renews && (
          <>
            <dt className="text-ink-muted">Renews</dt>
            <dd>{renews}</dd>
          </>
        )}
      </dl>

      {enabled && (
        <div className="space-y-1 text-sm text-ink-muted">
          <p>{premiumDisclosure(unit)}</p>
          <p>{PREMIUM_CALL_LENGTH_NOTE}</p>
        </div>
      )}
      {configured && !enabled && onSale && (
        <p className="banner-warn text-sm" role="status">Premium is paused because the plan is not paid up. Calls use Standard voice until the payment goes through.</p>
      )}
      {configured && !enabled && !onSale && (
        <p className="text-sm text-ink-muted" role="status">Premium voice is not available yet, so calls use Standard voice. You can still remove the add-on.</p>
      )}
      {configured && p?.removeAt && <p className="text-sm font-medium text-ink" role="status">{premiumFallbackLine(p.removeAt)}</p>}

      {/* Add to an existing subscription: review first, then an explicit confirm. */}
      {offer && needsGrade && canManage && (
        // Spec 10.2: not offered before the organization's first graded call. Neutral and actionable, no price or button.
        <p className="text-sm text-ink-muted" role="status">{PREMIUM_NEEDS_GRADED_CALL}</p>
      )}
      {offer && !needsGrade && trialing && canManage && (
        <p className="text-sm text-ink-muted" role="status">{PREMIUM_AFTER_TRIAL}</p>
      )}
      {offer && !needsGrade && !(trialing && canManage) && (
        canBuy ? (
          <div className="space-y-2 text-sm">
            <p className="text-ink-soft">{premiumPriceLine(unit, "month")} {premiumAnnualNote(unit)}</p>
            <p className="text-ink-muted">{premiumDisclosure(unit)}</p>
            <p className="text-ink-muted">{PREMIUM_CALL_LENGTH_NOTE}</p>
            {!preview ? (
              <button ref={addRef} type="button" className="btn-primary btn-sm" onClick={previewAdd} disabled={!!busy}>
                {busy === "preview" && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />}
                {ADD_PREMIUM_LABEL}
              </button>
            ) : (
              <Review
                id="premium-confirm-h"
                title="Review: add Premium voice"
                rows={[
                  ["Effective", "Today, on your next call"],
                  ["Charged today", `${formatCents(preview.dueNow, preview.currency)}, prorated to your renewal date`],
                  ["From " + (formatResetDate(preview.renewsAt ?? undefined) || "renewal"), `${formatCents(preview.renewalTotal, preview.currency)} per ${per(preview.interval)} in total`],
                  ...(plan === "team" ? [["Quantity", `${preview.quantity} seats`] as [string, string]] : []),
                ]}
                changes={[
                  plan === "team"
                    ? `${PREMIUM_MINUTES} Premium minutes per seat each month, shared across your team, from your plan minutes.`
                    : `${PREMIUM_MINUTES} Premium minutes each month, from your plan minutes.`,
                  "When they run out, the next call uses Standard voice, and nothing extra is charged.",
                  PREMIUM_CALL_LENGTH_NOTE,
                  "Amounts are before tax and discounts. Nothing is charged until you confirm.",
                ]}
                confirmLabel="Confirm and pay"
                busy={busy === "confirm"}
                onBack={() => { setPreview(null); setReturnFocus("add"); }}
                onConfirm={confirmAdd}
              />
            )}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-ink-muted"><Lock size={14} strokeWidth={1.75} aria-hidden />Premium voice is not on your plan. Ask your admin.</p>
        )
      )}
      {onSale && plan === "free" && !configured && <p className="text-sm text-ink-muted">Add Premium voice when you choose Pro or Team below.</p>}

      {/* Removal waits for the period end; Premium stays until then. Allowed whether or not Premium is on sale. */}
      {configured && canManage && !p?.removeAt && (
        !confirmRemove ? (
          <button ref={removeRef} type="button" className="btn-ghost btn-sm" onClick={() => setConfirmRemove(true)} disabled={!!busy}>Remove at period end</button>
        ) : (
          <Review
            id="premium-remove-h"
            title="Review: remove Premium voice"
            rows={[["Effective", renews || "End of this billing period"], ["Charged today", "Nothing"]]}
            changes={[
              `Premium stays on until ${renews || "the end of this billing period"}.`,
              "After that, every call uses Standard voice.",
              "Nothing is refunded for the current period.",
            ]}
            confirmLabel="Remove at period end"
            danger
            busy={busy === "remove"}
            onBack={() => { setConfirmRemove(false); setReturnFocus("remove"); }}
            onConfirm={remove}
          />
        )
      )}

      {/* Team seats: the Premium quantity follows the seats in the same change. */}
      {onSale && teamOwner && (
        <div className="space-y-2 border-t border-line pt-3 text-sm">
          <label className="label" htmlFor="premium-seats">Change seats</label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="premium-seats" className="input w-24 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" type="number" inputMode="numeric"
              min={TEAM_MIN_SEATS} max={TEAM_MAX_SEATS} value={seatsText} disabled={!!busy}
              aria-describedby="premium-seats-help" onChange={(e) => { setSeatsState({ text: e.target.value, edited: true }); setSeatPreview(null); }} />
            <button ref={seatsRef} type="button" className="btn-ghost btn-sm" onClick={previewSeats} disabled={!!busy || !seatsText.trim() || Number(seatsText) === seats}>
              {busy === "seats" && <Loader2 size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />}
              Review change
            </button>
          </div>
          <p id="premium-seats-help" className="text-xs text-ink-muted">Added seats are charged now, prorated, and add to the pool at once. Removed seats leave at your renewal date.{configured ? " Premium voice follows your seat count." : ""}</p>
          {seatPreview && (
            <Review
              id="seats-confirm-h"
              title={seatPreview.direction === "down" ? `Review: drop to ${seatPreview.quantity} seats` : `Review: go to ${seatPreview.quantity} seats`}
              rows={[
                ["Effective", seatPreview.direction === "down" ? formatResetDate(seatPreview.effectiveAt ?? undefined) || "Your renewal date" : "Today"],
                ["Charged today", seatPreview.direction === "down" ? "Nothing" : `${formatCents(seatPreview.dueNow, seatPreview.currency)}, prorated`],
                ["From " + (formatResetDate(seatPreview.renewsAt ?? undefined) || "renewal"), `${formatCents(seatPreview.renewalTotal, seatPreview.currency)} per ${per(seatPreview.interval)} in total`],
              ]}
              changes={[
                seatPreview.direction === "down" ? "Your team keeps every current seat until the renewal date." : "The new seats and their voice minutes are added to the pool at once.",
                ...(configured ? [`Premium voice moves to ${seatPreview.quantity} seats in the same change.`] : []),
              ]}
              confirmLabel={seatPreview.direction === "down" ? "Confirm change" : "Confirm and pay"}
              busy={busy === "seats-confirm"}
              onBack={() => { setSeatPreview(null); setReturnFocus("seats"); }}
              onConfirm={confirmSeats}
            />
          )}
        </div>
      )}

      {error && <p className="banner-warn text-sm" role="alert">{error}</p>}
      <p ref={doneRef} tabIndex={-1} role="status" aria-live="polite" className="text-sm font-medium text-ok outline-none">{done ?? ""}</p>
    </section>
  );
}

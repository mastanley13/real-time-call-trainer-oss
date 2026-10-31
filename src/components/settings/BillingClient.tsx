"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { clampSeats, formatMinutes, freeOverCapNotice, planPriceLine, premiumLabel, proButtonLabel, teamButtonLabel, usageHeaderCopy } from "@/lib/billingUi";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/usagePlan";
import SettingsNav from "./SettingsNav";

interface Usage {
  metered: boolean;
  plan?: "free" | "pro" | "team";
  pooled?: boolean;
  minutesCap?: number;
  minutesUsed?: number;
  remaining?: number;
  periodEnd?: string;
  premiumVoice?: { enabled: boolean; minutesCap: number };
  entries?: { id: string; kind: string; minutes: number; createdAt: string }[];
  billing: { enabled: boolean; testMode?: boolean; canBuyTeam?: boolean; hasPortal?: boolean; seats?: number; status?: string | null };
}

const PLAN_NAME = { free: "Free", pro: "Pro", team: "Team" } as const;
const KIND_LABEL: Record<string, string> = { voice_call: "Voice call", credit_drop: "Credit for a dropped call", credit_manual: "Credit from support" };

export default function BillingClient() {
  const { isAuthenticated, isLoading, capabilities } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [interval, setInterval] = useState<"month" | "year">("month");
  // The seat box holds what is typed. It is clamped on blur and on submit, not on each keystroke, so it can be
  // cleared and "10" can be typed without the box jumping back to 3 after the "1".
  const [seatsText, setSeatsText] = useState(String(TEAM_MIN_SEATS));
  const [premium, setPremium] = useState(false);
  // State updates are not instant, so two fast clicks could both pass a check on `busy`. The ref closes that gap.
  const busyRef = useRef<string | null>(null);

  useEffect(() => {
    if (capabilities && !isLoading && !isAuthenticated) router.replace("/login");
  }, [capabilities, isLoading, isAuthenticated, router]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { credentials: "include" });
      if (!res.ok) throw new Error();
      setUsage(await res.json());
    } catch {
      setError("Could not load your usage. Reload the page to try again.");
    }
  }, []);
  useEffect(() => { if (isAuthenticated) void load(); }, [isAuthenticated, load]);

  // Coming back from Stripe with the Back button restores this page as it was, busy and all. Free the buttons then.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { busyRef.current = null; setBusy(null); } };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  async function go(kind: "pro" | "team" | "portal") {
    if (busyRef.current) return;
    busyRef.current = kind;
    setBusy(kind);
    setError(null);
    // Team seats are clamped here too, so a box that was never blurred still sends 3 or more.
    const seats = clampSeats(seatsText);
    if (kind === "team") setSeatsText(String(seats));
    try {
      const res = await fetch(kind === "portal" ? "/api/billing/portal" : "/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "portal" ? {} : { plan: kind, interval, premium, ...(kind === "team" ? { seats } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.message || "Could not open billing. Try again in a moment.");
      window.location.assign(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open billing.");
      busyRef.current = null;
      setBusy(null);
    }
  }

  if (!capabilities || !isAuthenticated || (!usage && !error)) return <PageSkeleton rows={3} />;

  const u = usage;
  const pct = u?.minutesCap ? Math.min(100, Math.round(((u.minutesUsed ?? 0) / u.minutesCap) * 100)) : 0;
  const paid = u?.plan && u.plan !== "free";
  const checkout = params.get("checkout");
  const overCap = u?.metered ? freeOverCapNotice({ plan: u.plan, used: u.minutesUsed ?? 0, cap: u.minutesCap ?? 0, resetDate: u.periodEnd ? new Date(u.periodEnd).toLocaleDateString() : "" }) : null;

  return (
    <div className="page enter max-w-5xl space-y-6">
      <SettingsNav />
      <header>
        <p className="eyebrow">Settings</p>
        <h1 className="mt-1 text-3xl font-bold">Billing and usage</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{usageHeaderCopy(u?.metered ? u.plan : undefined, u?.pooled)}</p>
      </header>

      {checkout === "success" && <p className="banner-ok" role="status">Thanks. Your plan updates as soon as the payment is confirmed. Reload in a few seconds if it still shows the old plan.</p>}
      {error && <p className="banner-warn" role="alert">{error}</p>}

      {u?.metered ? (
        <section className="panel p-4 sm:p-5" aria-labelledby="usage-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="usage-h" className="text-lg font-bold">{PLAN_NAME[u.plan ?? "free"]} plan{u.pooled ? " (team pool)" : ""}</h2>
            <p className="mono text-xs text-ink-muted">Resets {u.periodEnd ? new Date(u.periodEnd).toLocaleDateString() : ""}</p>
          </div>
          <p className="mt-3 text-2xl font-bold">{formatMinutes(u.remaining ?? 0)} <span className="text-base font-normal text-ink-soft">of {u.minutesCap} voice minutes left</span></p>
          {overCap && <p className="banner-warn mt-3" role="status">{overCap}</p>}
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${pct}% of voice minutes used`}>
            <div className={`h-full ${pct >= 90 ? "bg-alert" : "bg-primary"}`} style={{ width: `${pct}%` }} />
          </div>
          {u.premiumVoice?.enabled && <p className="mt-3 text-sm text-ink-soft">Premium voice is on. It can use up to {u.premiumVoice.minutesCap} of your {u.minutesCap} minutes.</p>}
          {(u.entries?.length ?? 0) > 0 && (
            <ul className="mt-4 divide-y divide-line text-sm">
              {u.entries!.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{KIND_LABEL[e.kind] ?? e.kind}</span>
                  <span className="mono text-xs text-ink-muted">{new Date(e.createdAt).toLocaleString()}</span>
                  <span className="mono">{e.minutes > 0 ? `${formatMinutes(e.minutes)} min` : `${formatMinutes(e.minutes)} min credit`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="panel p-4 text-sm text-ink-soft">Voice minutes are not tracked in this environment.</p>
      )}

      {u?.billing.enabled && (
        <section className="panel p-4 sm:p-5" aria-labelledby="plans-h">
          <h2 id="plans-h" className="text-lg font-bold">Plans</h2>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <fieldset className="flex gap-2" aria-label="Billing period">
              {(["month", "year"] as const).map((v) => (
                <label key={v} className={`chip cursor-pointer ${interval === v ? "bg-primary-soft text-primary" : ""}`}>
                  <input type="radio" name="interval" className="sr-only" checked={interval === v} onChange={() => setInterval(v)} />
                  {v === "month" ? "Monthly" : "Annual, 2 months free"}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={premium} onChange={(e) => setPremium(e.target.checked)} />
              {premiumLabel(interval)}
            </label>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-line p-4">
              <h3 className="font-heading font-semibold">Pro</h3>
              <p className="text-sm text-ink-soft">{planPriceLine("pro", interval)}</p>
              {/* Truly disabled while any checkout is starting, so a double click cannot open two. */}
              <button type="button" className="btn-primary mt-3" onClick={() => go("pro")} disabled={!!busy || u.plan === "pro" || u.plan === "team"}>
                {busy === "pro" && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
                {proButtonLabel(u.plan)}
              </button>
            </div>
            <div className="rounded-lg border border-line p-4">
              <h3 className="font-heading font-semibold">Team</h3>
              <p className="text-sm text-ink-soft">{planPriceLine("team", interval)}</p>
              {u.billing.canBuyTeam ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div>
                    <label className="label" htmlFor="seats">Seats</label>
                    <input id="seats" className="input w-24" type="number" inputMode="numeric" min={TEAM_MIN_SEATS} max={TEAM_MAX_SEATS} value={seatsText} disabled={!!busy}
                      onChange={(e) => setSeatsText(e.target.value)} onBlur={() => setSeatsText(String(clampSeats(seatsText)))} />
                  </div>
                  <button type="button" className="btn-primary" onClick={() => go("team")} disabled={!!busy || u.plan === "team"}>
                    {busy === "team" && <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden />}
                    {teamButtonLabel(u.plan)}
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-sm text-ink-muted">Ask an owner or manager of your organization to buy Team.</p>
              )}
            </div>
          </div>

          {(paid || u.billing.hasPortal) && (
            <div className="mt-4">
              <button type="button" className="btn-ghost" onClick={() => go("portal")} disabled={!!busy}>
                {busy === "portal" ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" aria-hidden /> : <CreditCard size={16} strokeWidth={1.75} aria-hidden />}
                Manage billing
              </button>
              <p className="mt-2 text-xs text-ink-muted">Change plan or seats, update your card, or cancel.{u.billing.testMode ? " Test mode only: use Stripe test cards." : ""}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

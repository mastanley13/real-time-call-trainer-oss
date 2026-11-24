"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Check } from "lucide-react";
import { radioKeys } from "@/lib/radioKeys";
import { useBilling } from "@/components/landing/BillingContext";
import { usePricingViewer } from "@/components/landing/PricingViewer";
import {
  FREE_SUMMARY, OPEN_SOON_LINE, PREMIUM_COMING_SOON, PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_TEAM, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT,
  premiumPriceLine, registerHref, signedInTierAction, type Billing, type PricingViewer,
} from "@/lib/pricing";
import { trackPremiumUpsell } from "@/lib/premiumEventTypes";

const TIERS = [
  {
    id: "free", name: "Free", blurb: "Try it solo, no card.", cta: "Start free, no card",
    features: [FREE_SUMMARY, "Unlimited text sim", "Live coach channel", "Graded debriefs with transcript quotes", "Core persona library"],
  },
  {
    id: "pro", name: "Pro", blurb: "For individual reps who practice weekly.", cta: "Start Pro",
    features: [`${PRO_VOICE_MIN} voice minutes per month`, "Standard voice included", "Everything in Free", "Full persona library across every sales role", "Reviewed persona packs (coming soon)", "Persona wizard for your own buyers", "Call history and score trends", "MFA"],
  },
  {
    id: "team", name: "Team", blurb: `Built for a manager plus reps: ${TEAM_MIN_SEATS}-seat minimum.`, cta: "Start with Team",
    features: [`${TEAM_VOICE_MIN_PER_SEAT} voice minutes per seat, pooled across the team`, "Standard voice included", "Everything in Pro", "Managed Team view: every rep's calls, scores and trends", "Assignments: give reps a persona and a due date", "Enforced MFA for the whole team", "Priority email support"],
  },
] as const;

const PERIODS: readonly Billing[] = ["month", "year"];

function price(id: string, b: Billing) {
  if (id === "free") return { main: "$0", unit: "" };
  const p = id === "pro" ? PRICE.pro : PRICE.team;
  const seat = id === "team" ? " /seat" : "";
  return { main: `$${p[b]}`, unit: `${seat} /${b === "month" ? "month" : "year"}` };
}

/** The sign-up link and label for a tier. Billing off sells nothing, so Pro and Team read "Start free". */
export function tierAction(id: string, cta: string, billingEnabled: boolean, interval: Billing) {
  if (id === "free") return { cta, href: registerHref({ src: "pricing" }), soon: false };
  const plan = id === "pro" ? "pro" : "team";
  // The link carries the selected period in both states, so sign-up stores it either way.
  const href = registerHref({ plan, interval, src: "pricing" });
  return billingEnabled ? { cta, href, soon: false } : { cta: "Start free", href, soon: true };
}

/** A plan card's button for a signed-in viewer. Current plan is outlined and disabled, never a link. */
export function SignedInAction({ id, viewer, billingEnabled, interval }: { id: "free" | "pro" | "team"; viewer: PricingViewer; billingEnabled: boolean; interval: Billing }) {
  const a = signedInTierAction(id, viewer, billingEnabled, interval);
  switch (a.kind) {
    case "current":
      return <button type="button" className="btn-ghost" disabled>{a.cta}</button>;
    case "included":
    case "note":
      return <p className="flex min-h-[40px] items-center justify-center text-center text-sm text-ink-muted">{a.cta}</p>;
    case "link":
      return <Link href={a.href} className={id === "free" ? "btn-ghost" : "btn-primary"}>{a.cta}</Link>;
    case "disabled":
      return (
        <>
          <button type="button" className="btn-primary" disabled>{a.cta}</button>
          <p className="text-center text-xs text-ink-muted">{OPEN_SOON_LINE}</p>
        </>
      );
  }
}

/**
 * Billing toggle, tier cards and the Premium AI voice add-on row under them (one row, never a fourth card).
 * `billingEnabled` and `premiumOnSale` come from the server. The add-on row has no button: Premium is chosen at checkout
 * or added in billing settings, and off sale it carries the coming-soon label.
 * The period toggle is a radio group (one Tab stop, arrow keys move), like the coach mode dial on the call.
 */
export default function PricingCards({ billingEnabled, premiumOnSale = false }: { billingEnabled: boolean; premiumOnSale?: boolean }) {
  const { billing, setBilling } = useBilling();
  const viewer = usePricingViewer();
  useEffect(() => { if (premiumOnSale) trackPremiumUpsell("pricing"); }, [premiumOnSale]);
  const per = billing === "month" ? "month" : "year";
  return (
    <div>
      <div role="radiogroup" aria-label="Billing period" onKeyDown={radioKeys(PERIODS, billing, setBilling)}
        className="inline-grid max-w-full grid-cols-[auto_auto] gap-1 rounded-lg border border-line bg-sunken p-1">
        {PERIODS.map((b) => (
          <button key={b} type="button" role="radio" aria-checked={billing === b} tabIndex={billing === b ? 0 : -1} onClick={() => setBilling(b)}
            className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-semibold transition sm:px-4 ${billing === b ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted hover:text-ink"}`}>
            {b === "month" ? "Monthly" : <>Annual <span className={`font-mono text-[11px] font-medium ${billing === b ? "text-ok" : ""}`}>(2 months free)</span></>}
          </button>
        ))}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3 md:gap-y-0 lg:gap-x-6">
        {TIERS.map((t) => {
          const p = price(t.id, billing);
          const a = tierAction(t.id, t.cta, billingEnabled, billing);
          const featured = t.id === "team";
          return (
            <section key={t.id} aria-labelledby={`tier-${t.id}`}
              className={`card flex flex-col md:row-span-6 md:grid md:grid-rows-[subgrid] ${featured ? "shadow-pop ring-1 ring-primary/40" : ""}`}>
              <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-2">
                <h3 id={`tier-${t.id}`} className="text-lg font-bold">{t.name}</h3>
                {featured && <span className="chip border-primary/40 bg-primary-soft text-ink"><span className="lamp lamp-signal !h-1.5 !w-1.5" aria-hidden />For managers</span>}
              </div>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="font-mono text-4xl font-semibold tracking-tight tabular-nums text-ink">{p.main}</span>
                <span className="text-sm text-ink-muted">{p.unit}</span>
              </p>
              <p className="mt-1 min-h-[1.25rem] font-mono text-xs text-ok">
                {t.id !== "free" && billing === "year" ? "2 months free" : ""}
              </p>
              <p className="mt-2 text-sm text-ink-soft">{t.blurb}</p>
              <ul className="mt-5 flex-1 space-y-2.5 border-t border-line pt-5 text-sm text-ink-soft">
                {t.features.map((f) => f.endsWith("(coming soon)") ? (
                  <li key={f} className="flex gap-2.5 text-ink-muted"><span className="flex w-4 shrink-0 justify-center pt-[0.45em]" aria-hidden><span className="lamp lamp-off" /></span>{f}</li>
                ) : (
                  <li key={f} className="flex gap-2.5"><Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />{f}</li>
                ))}
              </ul>
              <div className="mt-6 flex flex-col gap-2">
                {viewer ? <SignedInAction id={t.id} viewer={viewer} billingEnabled={billingEnabled} interval={billing} /> : (
                  <>
                    <Link href={a.href} className={t.id === "free" ? "btn-ghost" : "btn-primary"}>{a.cta}</Link>
                    {a.soon && <p className="text-center text-xs text-ink-muted">{OPEN_SOON_LINE}</p>}
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="panel mt-4 grid gap-x-8 gap-y-4 p-5 sm:p-6 lg:mt-6 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h3 className="text-base font-bold">Add-on: Premium AI voice</h3>
          <p className="mt-2 flex flex-wrap items-baseline gap-1">
            <span className="font-mono text-2xl font-semibold tabular-nums text-ink">+${PRICE.premium[billing]}</span>
            <span className="text-sm text-ink-muted">/{per} on Pro, /seat /{per} on Team</span>
          </p>
          <span className="chip mt-3">
            <span className={`lamp ${premiumOnSale ? "lamp-ok" : "lamp-off"} !h-1.5 !w-1.5`} aria-hidden />{premiumOnSale ? "Pro and Team" : PREMIUM_COMING_SOON}
          </span>
        </div>
        <div className="min-w-0 border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <ul className="max-w-2xl space-y-1.5 text-sm text-ink">
            <li className="flex gap-2.5"><Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-primary" aria-hidden />{premiumPriceLine("pro", billing)}</li>
            <li className="flex gap-2.5"><Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-primary" aria-hidden />{premiumPriceLine("team", billing)}</li>
          </ul>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">
            A more lifelike, expressive voice for your buyers. Premium minutes come out of your plan minutes, not on top. {PREMIUM_DISCLOSURE_PRO} On Team: {PREMIUM_DISCLOSURE_TEAM.charAt(0).toLowerCase() + PREMIUM_DISCLOSURE_TEAM.slice(1)}
          </p>
        </div>
      </div>
    </div>
  );
}

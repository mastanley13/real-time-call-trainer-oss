"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { useBilling } from "@/components/landing/BillingContext";
import {
  FREE_SUMMARY, OPEN_SOON_LINE, PREMIUM_COMING_SOON, PREMIUM_VOICE_CAP_PCT, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT,
  registerHref, type Billing,
} from "@/lib/pricing";

const TIERS = [
  {
    id: "free", name: "Free", blurb: "Try it solo, no card.", cta: "Start free, no card",
    features: [FREE_SUMMARY, "Unlimited text sim", "Live coach channel", "Graded debriefs with transcript quotes", "Full persona library across every sales role", "Persona wizard for your own buyers", "Call history and score trends", "MFA"],
  },
  {
    id: "pro", name: "Pro", blurb: "For individual reps who practice weekly.", cta: "Start Pro",
    features: [`${PRO_VOICE_MIN} voice minutes per month`, "Everything in Free", "Email support", "Reviewed persona packs (coming soon)"],
  },
  {
    id: "team", name: "Team", blurb: `Built for a manager plus reps: ${TEAM_MIN_SEATS}-seat minimum.`, cta: "Start with Team",
    features: [`${TEAM_VOICE_MIN_PER_SEAT} voice minutes per seat, pooled across the team`, "Everything in Pro", "Managed Team view: every rep's calls, scores and trends", "Assignments: give reps a persona and a due date", "Enforced MFA for the whole team", "Priority email support"],
  },
] as const;

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

/** Billing toggle, tier cards and the Premium AI voice add-on. `billingEnabled` comes from the server. */
export default function PricingCards({ billingEnabled }: { billingEnabled: boolean }) {
  const { billing, setBilling } = useBilling();
  return (
    <div>
      <div role="group" aria-label="Billing period" className="inline-flex rounded-lg border border-line bg-sunken p-1">
        {(["month", "year"] as const).map((b) => (
          <button key={b} type="button" aria-pressed={billing === b} onClick={() => setBilling(b)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${billing === b ? "bg-surface text-ink shadow-card" : "text-ink-muted hover:text-ink"}`}>
            {b === "month" ? "Monthly" : "Annual (2 months free)"}
          </button>
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3 md:gap-y-0">
        {TIERS.map((t) => {
          const p = price(t.id, billing);
          const a = tierAction(t.id, t.cta, billingEnabled, billing);
          return (
            <section key={t.id} className="card flex flex-col md:row-span-6 md:grid md:grid-rows-[subgrid]" aria-labelledby={`tier-${t.id}`}>
              <h3 id={`tier-${t.id}`} className="text-lg font-bold">{t.name}</h3>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="font-heading text-4xl font-bold">{p.main}</span>
                <span className="text-sm text-ink-muted">{p.unit}</span>
              </p>
              <p className="mt-1 min-h-[1.25rem] font-mono text-xs text-ink-muted">
                {t.id !== "free" && billing === "year" ? "2 months free" : ""}
              </p>
              <p className="mt-2 text-sm text-ink-soft">{t.blurb}</p>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-soft">
                {t.features.map((f) => f.endsWith("(coming soon)") ? (
                  <li key={f} className="flex gap-2 text-ink-muted"><span className="w-4 shrink-0" aria-hidden />{f}</li>
                ) : (
                  <li key={f} className="flex gap-2"><Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />{f}</li>
                ))}
              </ul>
              <div className="mt-6 flex flex-col gap-2">
                <Link href={a.href} className={t.id === "free" ? "btn-ghost" : "btn-primary"}>{a.cta}</Link>
                {a.soon && <p className="text-center text-xs text-ink-muted">{OPEN_SOON_LINE}</p>}
              </div>
            </section>
          );
        })}
      </div>

      <div className="panel mt-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-base font-bold">Add-on: Premium AI voice</h3>
          <span className="chip">{PREMIUM_COMING_SOON}</span>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          The full realtime voice model for your buyers, more lifelike and expressive. It can use up to {PREMIUM_VOICE_CAP_PCT}% of your plan minutes. After that, calls fall back to standard voice and never stop. No extra minute charges.
        </p>
      </div>
    </div>
  );
}

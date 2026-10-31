"use client";

import Link from "next/link";
import { useState } from "react";
import { Check } from "lucide-react";
import {
  FREE_VOICE_MIN, PREMIUM_VOICE_CAP_PCT, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT,
  registerHref, type Billing,
} from "@/lib/pricing";

const TIERS = [
  {
    id: "free", name: "Free", blurb: "For trying it on a tough buyer.", cta: "Start free, no card",
    href: registerHref({ src: "pricing" }),
    features: [`${FREE_VOICE_MIN} voice minutes per month`, "Unlimited text sim", "Live coach channel", "Graded debriefs with transcript quotes", "Core persona library"],
  },
  {
    id: "pro", name: "Pro", blurb: "For the rep who wants reps.", cta: "Start Pro",
    href: registerHref({ plan: "pro", src: "pricing" }),
    features: [`${PRO_VOICE_MIN} voice minutes per month`, "Everything in Free", "Full persona library across every sales role", "Reviewed persona packs (coming soon)", "Persona wizard for your own buyers", "Call history and score trends", "MFA"],
  },
  {
    id: "team", name: "Team", blurb: `${TEAM_MIN_SEATS}-seat minimum. For managers ramping a team.`, cta: "Start with Team",
    href: registerHref({ plan: "team", src: "pricing" }),
    features: [`${TEAM_VOICE_MIN_PER_SEAT} voice minutes per seat, pooled across the team`, "Everything in Pro", "Managed Team view: every rep's calls, scores and trends", "Assignments: give reps a persona and a due date", "Enforced MFA for the whole team", "Priority email support"],
  },
] as const;

function price(id: string, b: Billing) {
  if (id === "free") return { main: "$0", unit: "" };
  const p = id === "pro" ? PRICE.pro : PRICE.team;
  const seat = id === "team" ? " /seat" : "";
  return { main: `$${p[b]}`, unit: `${seat} /${b === "month" ? "month" : "year"}` };
}

/** Billing toggle, tier cards and the Premium voice add-on. */
export default function PricingCards() {
  const [billing, setBilling] = useState<Billing>("month");
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

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {TIERS.map((t) => {
          const p = price(t.id, billing);
          return (
            <section key={t.id} className="card flex flex-col" aria-labelledby={`tier-${t.id}`}>
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
                {t.features.map((f) => (
                  <li key={f} className="flex gap-2"><Check size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ok" aria-hidden />{f}</li>
                ))}
              </ul>
              <Link href={t.href} className={`mt-6 ${t.id === "free" ? "btn-ghost" : "btn-primary"}`}>{t.cta}</Link>
            </section>
          );
        })}
      </div>

      <div className="panel mt-4 p-5">
        <h3 className="text-base font-bold">Add-on: Premium voice</h3>
        <p className="mt-2 flex items-baseline gap-1">
          <span className="font-heading text-2xl font-bold">+${PRICE.premium[billing]}</span>
          <span className="text-sm text-ink-muted">/seat /{billing === "month" ? "month" : "year"}</span>
        </p>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          The full realtime voice model for your buyers, more lifelike and expressive. It can use up to {PREMIUM_VOICE_CAP_PCT}% of your plan minutes. After that, calls fall back to standard voice and never stop. No extra minute charges.
        </p>
      </div>
    </div>
  );
}

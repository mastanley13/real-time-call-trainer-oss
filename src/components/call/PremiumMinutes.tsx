"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Clock, Lock } from "lucide-react";
import { ADD_PREMIUM_LABEL, ASK_ADMIN_PREMIUM, BILLING_PATH, premiumLeftLabel, premiumSetupState, premiumTrialLine, type PremiumSnapshot } from "@/lib/billingUi";
import { PREMIUM_CALL_LENGTH_NOTE, premiumDisclosure, premiumNudge } from "@/lib/pricing";
import { trackPremiumUpsell } from "@/lib/premiumEventTypes";

/**
 * The Premium voice line on the call setup, next to the voice minutes. From /api/usage, which reads the entitlement from
 * the database; the server decides the voice again at mint, so this is information only and never picks the model.
 * - Entitled: "Premium: N of 40 min left" (Team: the pooled capacity, 40 x units), with the disclosure.
 * - Used up: the nudge (calls continue on Standard, free).
 * - Not on the plan while Premium is on sale: locked, with Add Premium voice (a buyer) or Ask your admin (a Team member).
 * - The owner during a Stripe trial: when Premium starts (or can be added), with no admin line.
 * - Free, or off sale and not on the plan: nothing.
 */
export default function PremiumMinutes({ premium }: { premium: PremiumSnapshot | null }) {
  const state = premiumSetupState(premium).kind;
  const locked = state === "locked_buy" || state === "locked_ask";
  useEffect(() => { if (locked) trackPremiumUpsell("setup"); }, [locked]);
  if (!premium || state === "none") return null;
  const plan = premium.plan === "team" ? "team" : "pro";
  if (state === "left") {
    return (
      <div className="text-sm" role="status">
        <p className="mono text-ink-soft">{premiumLeftLabel(premium)}</p>
        <p className="mt-1 text-xs text-ink-muted">{premiumDisclosure(plan)}</p>
        {/* Below the generic copy: a Premium call is set to end when the Premium minutes run out. */}
        <p className="mt-1 text-xs text-ink-muted">{PREMIUM_CALL_LENGTH_NOTE}</p>
      </div>
    );
  }
  if (state === "waiting_trial") {
    // Prism u63 Medium 2: the owner during a Stripe trial. Not an upsell, and never "Ask your admin".
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted" role="status">
        <Clock size={14} strokeWidth={1.75} aria-hidden />
        <span>{premiumTrialLine(premium)}</span>
      </p>
    );
  }
  if (state === "used_up") {
    return (
      <div className="text-sm" role="status">
        <p className="mono text-ink-soft">{premiumLeftLabel({ remaining: 0, cap: premium.cap })}</p>
        <p className="mt-1 text-xs text-ink-muted">{premiumNudge(plan)}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
      <Lock size={14} strokeWidth={1.75} aria-hidden />
      <span>Premium voice is not on your plan.</span>
      {state === "locked_buy"
        ? <Link href={BILLING_PATH} className="font-semibold text-primary underline-offset-2 hover:underline">{ADD_PREMIUM_LABEL}</Link>
        : <span className="font-medium text-ink-soft">{ASK_ADMIN_PREMIUM}</span>}
    </div>
  );
}

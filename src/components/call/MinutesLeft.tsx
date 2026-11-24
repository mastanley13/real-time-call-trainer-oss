import Link from "next/link";
import {
  ASK_ADMIN_MESSAGE, OUT_OF_MINUTES_MESSAGE, TEXT_UNLIMITED_MESSAGE, formatResetDate, upgradePath, voiceMinutesLeftLabel, type UsageSnapshot,
} from "@/lib/billingUi";

/**
 * The voice minutes count near Start call on the briefing, from /api/usage. Nothing when minutes are not metered.
 * Voice mode: "X of Y voice minutes left", or, with none left, "0 of Y voice minutes left", the reset date and an Upgrade
 * link (to billing, or to /pricing when billing is off; "Ask your team admin for more minutes." for a Team pool member who
 * cannot buy minutes). Text mode: text is never counted. It shows whether or not voice keys are set up, so the count is
 * visible in every state.
 */
export default function MinutesLeft({ usage, mode, canUpgrade = true }: { usage: UsageSnapshot | null; mode: "voice" | "text"; canUpgrade?: boolean }) {
  if (!usage) return null;
  if (mode === "text") return <p className="text-sm text-ink-muted" role="status">{TEXT_UNLIMITED_MESSAGE}</p>;
  if (usage.remaining > 0) {
    const pct = usage.cap > 0 ? Math.min(100, Math.max(0, (usage.remaining / usage.cap) * 100)) : 0;
    return (
      <div role="status" className="space-y-1.5">
        <p className="mono text-sm text-ink-soft">{voiceMinutesLeftLabel(usage)}</p>
        {/* Fuel gauge: the share of this period's minutes still in the tank. Caution once a fifth or less is left. */}
        <div className="tape" aria-hidden><span className={pct <= 20 ? "bg-caution" : "bg-ok"} style={{ width: `${pct}%` }} /></div>
      </div>
    );
  }
  const resets = formatResetDate(usage.resetsAt);
  return (
    <div id="minutes-out" role="status" className="banner-alert">
      <p className="mono">{voiceMinutesLeftLabel({ ...usage, remaining: 0 })}</p>
      <p className="mt-1">{OUT_OF_MINUTES_MESSAGE}{resets && ` Resets ${resets}.`}</p>
      {canUpgrade
        ? <Link href={upgradePath(usage)} className="btn-primary btn-sm mt-2">Upgrade</Link>
        : <p className="mt-2 font-medium">{ASK_ADMIN_MESSAGE}</p>}
    </div>
  );
}

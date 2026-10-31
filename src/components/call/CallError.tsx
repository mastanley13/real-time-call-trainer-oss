import Link from "next/link";
import { ASK_ADMIN_MESSAGE, BILLING_PATH, capCopy } from "@/lib/billingUi";

/**
 * An error on the briefing or the call screen. When the message means the voice minutes are used up, an Upgrade
 * link to the billing page sits next to it; Text practice stays available either way. Someone who cannot buy
 * minutes (a Team pool member who is not an owner or manager) is told to ask their team admin instead of getting a link.
 */
export default function CallError({ message, className = "", role = "alert", canUpgrade = true }: { message: string; className?: string; role?: "alert" | "status"; canUpgrade?: boolean }) {
  const copy = capCopy(message, canUpgrade);
  return (
    <div role={role} className={`rounded-panel border border-alert/40 bg-alert-soft p-3 text-sm ${className}`}>
      <p>{copy.text}</p>
      {copy.action === "upgrade" && <Link href={BILLING_PATH} className="btn-primary btn-sm mt-2">Upgrade</Link>}
      {copy.action === "ask_admin" && <p className="mt-2 font-medium">{ASK_ADMIN_MESSAGE}</p>}
    </div>
  );
}

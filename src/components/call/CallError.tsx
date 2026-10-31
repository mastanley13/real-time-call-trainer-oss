import Link from "next/link";
import { BILLING_PATH, isCapMessage } from "@/lib/billingUi";

/**
 * An error on the briefing or the call screen. When the message means the voice minutes are used up, an Upgrade
 * link to the billing page sits next to it; Text practice stays available either way.
 */
export default function CallError({ message, className = "", role = "alert" }: { message: string; className?: string; role?: "alert" | "status" }) {
  const cap = isCapMessage(message);
  return (
    <div role={role} className={`rounded-panel border border-alert/40 bg-alert-soft p-3 text-sm ${className}`}>
      <p>{message}</p>
      {cap && <Link href={BILLING_PATH} className="btn-primary btn-sm mt-2">Upgrade</Link>}
    </div>
  );
}

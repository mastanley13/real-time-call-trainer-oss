import { AlertTriangle } from "lucide-react";
import { SUPPORT_URL } from "@/lib/billingUi";

/**
 * The error banner on the billing page. It stays an alert. When a checkout could not start because of a server or
 * configuration problem, `help` adds a link to the project's issues page, since there is no support email yet.
 */
export default function BillingAlert({ message, help = false }: { message: string; help?: boolean }) {
  return (
    // banner-warn, not banner-alert: tests/round7-ux.test.ts pins this style for every billing failure.
    <p className="banner-warn flex items-start gap-2" role="alert">
      <AlertTriangle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-caution" aria-hidden />
      <span>
        {message}
        {help && (
          <>
            {" "}
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">Report a problem on GitHub</a>
          </>
        )}
      </span>
    </p>
  );
}

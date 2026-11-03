import { SUPPORT_URL } from "@/lib/billingUi";

/**
 * The error banner on the billing page. It stays an alert. When a checkout could not start because of a server or
 * configuration problem, `help` adds a link to the project's issues page, since there is no support email yet.
 */
export default function BillingAlert({ message, help = false }: { message: string; help?: boolean }) {
  return (
    <p className="banner-warn" role="alert">
      {message}
      {help && (
        <>
          {" "}
          <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">Report a problem on GitHub</a>
        </>
      )}
    </p>
  );
}

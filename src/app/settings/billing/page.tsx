import { Suspense } from "react";
import BillingClient from "@/components/settings/BillingClient";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { pageTitle } from "@/lib/tenant";

export const metadata = { title: pageTitle("Billing") };

export default function BillingSettingsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageSkeleton rows={3} />}>
      <BillingClient />
    </Suspense>
  );
}

import { Suspense } from "react";
import BillingClient from "@/components/settings/BillingClient";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const metadata = { title: "Billing · Real-Time Call Trainer" };

export default function BillingSettingsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageSkeleton rows={3} />}>
      <BillingClient />
    </Suspense>
  );
}

import { Suspense } from "react";
import CheckoutStartClient from "@/components/CheckoutStartClient";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { pageTitle } from "@/lib/tenant";

export const metadata = { title: pageTitle("Checkout"), robots: { index: false } };

export default function CheckoutStartPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageSkeleton rows={2} />}>
      <CheckoutStartClient />
    </Suspense>
  );
}

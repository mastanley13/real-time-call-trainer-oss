import { Suspense } from "react";
import CheckoutStartClient from "@/components/CheckoutStartClient";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const metadata = { title: "Checkout · Real-Time Call Trainer", robots: { index: false } };

export default function CheckoutStartPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageSkeleton rows={2} />}>
      <CheckoutStartClient />
    </Suspense>
  );
}

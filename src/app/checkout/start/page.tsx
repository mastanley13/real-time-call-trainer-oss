import { Suspense } from "react";
import CheckoutStartClient, { CheckoutSkeleton } from "@/components/CheckoutStartClient";

export const metadata = { title: "Checkout · Real-Time Call Trainer", robots: { index: false } };

export default function CheckoutStartPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<CheckoutSkeleton />}>
      <CheckoutStartClient />
    </Suspense>
  );
}

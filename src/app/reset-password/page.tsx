import type { Metadata } from "next";
import { Suspense } from "react";
import ResetPasswordForm from "@/components/ResetPasswordForm";

export const metadata: Metadata = {
  title: "Choose a new password · Real-Time Call Trainer",
  robots: { index: false, follow: false },
  // The token is in the query string; keep it out of the Referer header of any link on the page.
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

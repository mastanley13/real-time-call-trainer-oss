import { Suspense } from "react";
import MembersClient from "@/components/settings/MembersClient";
import { PageSkeleton } from "@/components/ui/Skeleton";

export const metadata = { title: "Members · Real-Time Call Trainer" };

export default function MembersSettingsPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<PageSkeleton rows={3} />}>
      <MembersClient />
    </Suspense>
  );
}

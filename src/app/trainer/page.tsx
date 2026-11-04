import { Suspense } from "react";
import PlanNotice from "@/components/PlanNotice";
import TrainerClient from "@/components/TrainerClient";
import { PageSkeleton } from "@/components/ui/Skeleton";

export default function TrainerPage() {
  // TrainerClient reads the query string, which Next requires to sit under a Suspense boundary.
  return (
    <>
      <PlanNotice />
      <Suspense fallback={<PageSkeleton rows={2} />}>
        <TrainerClient />
      </Suspense>
    </>
  );
}

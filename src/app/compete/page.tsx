import type { Metadata } from "next";
import CompeteClient from "@/components/compete/CompeteClient";
import PublicFooter from "@/components/landing/PublicFooter";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Launch Sales Call Championship | Call Trainer",
  description:
    "Take 3 free voice calls across 7 real sales tracks, get scored by a live AI grader, and compete for 1 year of Pro free plus a Team seat bonus.",
  path: "/compete",
});

/** The 30-day launch championship hub: rules, prizes, the seven tracks, the quick brief and the live leaderboard. */
export default function CompetePage() {
  return (
    <div>
      <CompeteClient />
      <PublicFooter />
    </div>
  );
}

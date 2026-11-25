import type { Metadata } from "next";
import Link from "next/link";
import CompeteClient from "@/components/compete/CompeteClient";
import PublicFooter from "@/components/landing/PublicFooter";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Launch Sales Call Championship | Call Trainer",
  description:
    "Take 3 free voice calls across 7 real sales tracks, get scored by a live AI grader, and compete for 1 year of Pro free plus a Team seat bonus.",
  path: "/compete",
});

const COMPARE_LINK = "underline underline-offset-2 transition-colors hover:text-ink";

/** The 30-day launch championship hub: rules, prizes, the seven tracks, the quick brief and the live leaderboard. */
export default function CompetePage() {
  return (
    <div>
      <CompeteClient />
      <p className="page !py-6 text-sm text-ink-muted">
        Comparing tools? See <Link href="/alternatives" className={COMPARE_LINK}>AI sales roleplay alternatives</Link>, or Call Trainer vs{" "}
        <Link href="/vs/hyperbound" className={COMPARE_LINK}>Hyperbound</Link>,{" "}
        <Link href="/vs/second-nature" className={COMPARE_LINK}>Second Nature</Link>, and{" "}
        <Link href="/vs/yoodli" className={COMPARE_LINK}>Yoodli</Link>.
      </p>
      <PublicFooter />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ArrowRight, Trophy } from "lucide-react";
import ShareCardActions from "@/components/compete/ShareCardActions";
import PublicFooter from "@/components/landing/PublicFooter";
import { COMPETITION_MAX_ATTEMPTS, COMPETITION_TRACKS } from "@/lib/competition";
import { getCompetitionShareCard } from "@/lib/competitionServer";
import { siteUrl } from "@/lib/seo";

type Props = { params: Promise<{ token: string }> };

/** Share tokens are URL-safe ids. Anything else is a 404 without a database lookup. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One lookup per request, shared by generateMetadata and the page. */
const loadCard = cache(async (token: string) => (TOKEN_RE.test(token) ? getCompetitionShareCard(token) : null));

const cardPath = (token: string) => `/compete/card/${encodeURIComponent(token)}`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const card = await loadCard(token);
  if (!card) return { title: { absolute: "Score card not found | Call Trainer" }, robots: { index: false } };
  const title = `${card.displayName} scored ${card.overallScore}/100 (${card.grade}) in ${card.trackLabel} | Call Trainer Championship`;
  const description = `Can you beat ${card.overallScore}? Take ${COMPETITION_MAX_ATTEMPTS} free voice sales calls across ${COMPETITION_TRACKS.length} industries in the ${card.seasonTitle}.`;
  const url = `${siteUrl()}${cardPath(token)}`;
  const image = { url: `${url}/opengraph-image`, width: 1200, height: 630, alt: `${card.displayName} scored ${card.overallScore} out of 100 in ${card.trackLabel}` };
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    // Share cards are meant for the people a rep sends them to, not for search results.
    robots: { index: false, follow: true },
    openGraph: { type: "website", url, siteName: "Real-Time Call Trainer", title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

function completedOn(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
}

/** Public, shareable championship score card: score, grade, ranks, share buttons and a call to compete. */
export default async function ShareCardPage({ params }: Props) {
  const { token } = await params;
  const card = await loadCard(token);
  if (!card) notFound();
  const url = `${siteUrl()}${cardPath(token)}`;
  const shareText = `I scored ${card.overallScore}/100 (${card.grade}) on the ${card.trackLabel} track of the ${card.seasonTitle}. Think you can beat it?`;
  const date = completedOn(card.completedAt);

  return (
    <div>
      <section className="deck border-b border-line">
        <div className="page flex flex-col items-center py-10 sm:py-16">
          <article className="panel w-full max-w-xl overflow-hidden shadow-pop" aria-labelledby="card-name">
            <div className="h-1.5 bg-signal" aria-hidden />
            <div className="p-5 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="eyebrow inline-flex items-center gap-2"><Trophy size={13} strokeWidth={1.75} aria-hidden /> {card.seasonTitle}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {card.demoMode && <span className="chip">Demo preview</span>}
                  <span className="chip">{card.trackLabel}</span>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <span className="badge mono bg-primary text-primary-on">#{card.overallRank} Overall</span>
                <span className="badge mono bg-primary-soft text-primary">#{card.industryRank} in {card.trackLabel}</span>
              </div>

              <div className="mt-6 flex flex-wrap items-end gap-x-3 gap-y-3">
                <p className="flex items-baseline gap-2" aria-label={`Score ${card.overallScore} out of 100`}>
                  <span className="mono text-7xl font-bold leading-none text-ink sm:text-8xl">{card.overallScore}</span>
                  <span className="mono text-2xl text-ink-muted">/ 100</span>
                </p>
                <span className="ml-auto inline-flex flex-col items-center rounded-panel border border-line bg-sunken px-4 py-2">
                  <span className="label !mb-0">Grade</span>
                  <span className="mono text-3xl font-bold leading-none text-primary">{card.grade}</span>
                </span>
              </div>

              <p className="mt-4 inline-flex items-center gap-2 text-sm text-ink-soft">
                <span className={`lamp ${card.goalAchieved ? "lamp-ok" : "lamp-off"}`} aria-hidden />
                {card.goalAchieved ? "Call goal achieved" : "Call goal not reached"}
              </p>

              <div className="mt-6 border-t border-line pt-5">
                <h1 id="card-name" className="break-words text-2xl font-bold">{card.displayName}</h1>
                {card.teamLabel && <p className="mt-0.5 text-sm text-ink-muted">{card.teamLabel}</p>}
                <p className="mt-2 text-sm text-ink-soft">
                  vs. {card.buyerName}
                  {date && <> <span aria-hidden>·</span> {date}</>}
                  {card.totalEntries > 0 && <> <span aria-hidden>·</span> {card.totalEntries} official {card.totalEntries === 1 ? "score" : "scores"} posted</>}
                </p>
              </div>

              <div className="mt-6">
                <ShareCardActions url={url} text={shareText} />
              </div>
            </div>
          </article>

          <aside className="card mt-6 w-full max-w-xl text-center" aria-labelledby="beat-title">
            <h2 id="beat-title" className="text-xl font-bold">Think you can beat {card.overallScore}?</h2>
            <p className="mt-2 text-sm text-ink-soft">
              Pick one of {COMPETITION_TRACKS.length} industries, read a 30-second brief, and run a blind voice call scored by a live AI grader.
            </p>
            <Link href="/compete" className="btn-primary btn-xl mt-5 w-full sm:w-auto">
              Take {COMPETITION_MAX_ATTEMPTS} free competition calls <ArrowRight size={18} strokeWidth={1.75} aria-hidden />
            </Link>
          </aside>
        </div>
      </section>
      <PublicFooter />
    </div>
  );
}

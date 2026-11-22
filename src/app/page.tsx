import Link from "next/link";
import HeroDeck from "@/components/landing/HeroDeck";
import PublicFooter from "@/components/landing/PublicFooter";
import { FREE_LINE, HERO_HEADLINE, HOME_STEPS } from "@/lib/homeCopy";
import { registerHref } from "@/lib/pricing";
import { GITHUB_URL, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Real-Time Call Trainer · Hosted AI sales call practice, no setup",
  description:
    "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
  path: "/",
});

/**
 * Practice Desk landing. Static and server-rendered: no client code, so nothing here can ask for the microphone.
 * Self-hosting, model and environment details live in the README (Setup), not on this page.
 */
export default function Home() {
  return (
    <div className="focus-strong text-base leading-6">
      <section aria-labelledby="hero-h" className="site-wrap">
        <div className="grid items-center gap-10 py-10 md:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="flex min-w-0 flex-col gap-6">
            <h1 id="hero-h" className="max-w-[20ch] text-[36px] font-bold leading-[1.1] sm:text-[42px] lg:text-[56px] lg:leading-[1.08]">
              {HERO_HEADLINE}
            </h1>
            <p className="max-w-[60ch] text-lg leading-7 text-ink-soft">
              Sales call practice, no setup required. Talk to buyers who push back, get coached live, and review a debrief that quotes your own words.
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Link href={registerHref({ src: "home_hero" })} className="btn-primary btn-lg">Start free, no card</Link>
              <Link href="/pricing" className="inline-flex min-h-[48px] items-center rounded-control px-1 font-medium text-ink underline underline-offset-4 hover:text-primary">
                See pricing
              </Link>
            </div>
            <p className="text-sm leading-5 text-ink-soft">{FREE_LINE}</p>
          </div>
          <HeroDeck />
        </div>
      </section>

      <section aria-labelledby="how-h" className="site-wrap">
        <div className="border-t border-line pb-16 pt-6">
          <h2 id="how-h" className="text-2xl font-bold leading-8 sm:text-[27px] sm:leading-9">Brief, call, debrief. Then go again.</h2>
          <ol role="list" className="mt-10 grid list-none gap-8 md:grid-cols-3 md:gap-10">
            {HOME_STEPS.map((s, i) => (
              <li key={s.step} className="min-w-0">
                <p className="font-semibold text-primary"><span aria-hidden="true">{i + 1}. </span>{s.step}</p>
                <h3 className="mt-3 text-lg font-bold leading-7">{s.title}</h3>
                <p className="mt-2 max-w-[60ch] text-ink-soft">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <PublicFooter>
        <p>
          MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo ·{" "}
          <a href={`${GITHUB_URL}#setup`} target="_blank" rel="noreferrer" className="rounded underline underline-offset-4 hover:text-ink">
            Self-hosting guide for developers
          </a>
        </p>
      </PublicFooter>
    </div>
  );
}

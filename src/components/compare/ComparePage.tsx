import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import PublicFooter from "@/components/landing/PublicFooter";
import FaqList from "@/components/ui/FaqList";
import {
  ALTERNATIVES_LINK_LABEL, ALTERNATIVES_PATH, PRIMARY_CTA_LABEL, SECONDARY_CTA, faqJsonLd, jsonLdScript, pageCrumbs, pageJsonLd, parseRich,
  type Block, type ComparePageCopy, type Rich,
} from "@/lib/comparisons";
import { registerHref } from "@/lib/pricing";
import { siteUrl } from "@/lib/seo";

const LINK = "font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:text-primary-hover hover:decoration-current";

/** Inline copy: plain text, `code` spans, and links (next/link for site paths, a new tab for other sites). */
function RichText({ text }: { text: Rich }) {
  return (
    <>
      {parseRich(text).map((part, i) => {
        if ("text" in part) return <span key={i}>{part.text}</span>;
        if ("code" in part) return <code key={i} className="mono break-all rounded bg-sunken px-1 py-px text-[0.9em]">{part.code}</code>;
        if (part.href.startsWith("/")) return <Link key={i} href={part.href} className={LINK}>{part.label}</Link>;
        return (
          <a key={i} href={part.href} target="_blank" rel="noreferrer" className={`${LINK} break-words`}>
            {part.label}
            <ExternalLink size={12} strokeWidth={1.75} className="ml-0.5 inline align-baseline" aria-hidden />
          </a>
        );
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if ("p" in block) return <p><RichText text={block.p} /></p>;
  if ("ul" in block) {
    return (
      <ul className="list-disc space-y-2 pl-5">
        {block.ul.map((item) => <li key={item}><RichText text={item} /></li>)}
      </ul>
    );
  }
  const { head, rows } = block.table;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken/60">
            {head.map((h) => <th key={h} scope="col" className="px-4 py-3 font-heading font-semibold text-ink">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(([topic, ours, theirs]) => (
            <tr key={topic} className="align-top">
              <th scope="row" className="w-[22%] px-4 py-3 font-medium text-ink">{topic}</th>
              <td className="w-[34%] px-4 py-3 text-ink-soft"><RichText text={ours} /></td>
              <td className="px-4 py-3 text-ink-soft"><RichText text={theirs} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A public SEO page: /vs comparisons, /alternatives, /ai-sales-roleplay, and use-case landings. Copy is fully server-rendered. */
export default function ComparePage({ page }: { page: ComparePageCopy }) {
  const origin = siteUrl();
  const signup = registerHref({ src: page.src });
  const { parent, current } = pageCrumbs(page);
  const showAlternativesLink = page.kind === "vs" || page.kind === "alt";
  return (
    <div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqJsonLd(page)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(pageJsonLd(page, origin)) }} />

      <section className="deck border-b border-line">
        <div className="page py-14 sm:py-20">
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-muted">
              <li><Link href="/" className="rounded transition-colors hover:text-ink">Home</Link></li>
              {parent ? (
                <>
                  <li aria-hidden>/</li>
                  <li><Link href={parent.path} className="rounded transition-colors hover:text-ink">{parent.name}</Link></li>
                  <li aria-hidden>/</li>
                  <li aria-current="page" className="text-ink-soft">{current}</li>
                </>
              ) : (
                <>
                  <li aria-hidden>/</li>
                  <li aria-current="page" className="text-ink-soft">{current}</li>
                </>
              )}
            </ol>
          </nav>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] sm:text-5xl">{page.h1}</h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">{page.subhead}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href={signup} className="btn-primary btn-xl">{PRIMARY_CTA_LABEL}<ArrowRight size={18} strokeWidth={1.75} aria-hidden /></Link>
            <Link href={SECONDARY_CTA.href} className="btn-ghost btn-xl">{SECONDARY_CTA.label}</Link>
          </div>
          {showAlternativesLink && (
            <p className="mt-5 text-sm text-ink-muted">
              <Link href={ALTERNATIVES_PATH} className="underline underline-offset-2 transition-colors hover:text-ink">{ALTERNATIVES_LINK_LABEL}</Link>
            </p>
          )}
        </div>
      </section>

      <div className="page py-12 sm:py-16">
        <div className="max-w-[78ch] space-y-12 leading-relaxed text-ink-soft">
          {page.sections.map((s, i) => (
            <section key={s.heading ?? `intro-${i}`} aria-labelledby={s.heading ? `s${i}-h` : undefined} className="space-y-4">
              {s.heading && <h2 id={`s${i}-h`} className="text-2xl font-bold text-ink sm:text-[28px]">{s.heading}</h2>}
              {s.blocks.map((b, j) => <BlockView key={j} block={b} />)}
            </section>
          ))}
        </div>
      </div>

      <section className="border-t border-line bg-surface" aria-labelledby="faq-h">
        <div className="page grid gap-8 py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
          <div className="min-w-0">
            <h2 id="faq-h" className="text-2xl font-bold sm:text-[28px]">Questions</h2>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row lg:flex-col lg:items-start">
              <Link href={signup} className="btn-primary">{PRIMARY_CTA_LABEL}</Link>
              <Link href={SECONDARY_CTA.href} className="btn-ghost">{SECONDARY_CTA.label}</Link>
            </div>
          </div>
          <FaqList items={page.faq.map((f) => ({ q: f.q, a: <RichText text={f.a} /> }))} className="min-w-0" />
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

import Link from "next/link";
import LogoMark from "@/components/LogoMark";
import { CONTACT_LINK, LEGAL_LINKS } from "@/lib/legalLinks";
import { GITHUB_URL } from "@/lib/seo";

const LINKS = [{ href: "/pricing", label: "Pricing" }, ...LEGAL_LINKS];

/** Shared Flight Deck footer for public and legal pages: brand mark, links, and optional attribution. */
export default function PublicFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="border-t border-line bg-surface/60 text-sm text-ink-muted">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
          <Link href="/" className="inline-flex items-center gap-2.5 rounded-lg font-heading text-sm font-bold text-ink">
            <LogoMark size={26} />
            <span>Call Trainer</span>
            <span className="rounded border border-line bg-sunken px-1.5 py-px font-mono text-[10px] font-medium text-ink-muted">OSS</span>
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="rounded py-1 transition-colors hover:text-ink">{l.label}</Link>
            ))}
            <a href={CONTACT_LINK.href} className="rounded py-1 transition-colors hover:text-ink">{CONTACT_LINK.label}</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="rounded py-1 transition-colors hover:text-ink">GitHub</a>
          </nav>
        </div>
        {children && (
          <div className="border-t border-line pt-5 text-xs text-ink-muted">
            {children}
          </div>
        )}
      </div>
    </footer>
  );
}

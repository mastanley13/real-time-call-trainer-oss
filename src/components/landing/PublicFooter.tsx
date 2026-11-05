import Link from "next/link";
import { CONTACT_LINK, LEGAL_LINKS } from "@/lib/legalLinks";
import { GITHUB_URL } from "@/lib/seo";
import { brand, featureAllowed } from "@/lib/tenant";

const LINKS = [...(featureAllowed("pricing") ? [{ href: "/pricing", label: "Pricing" }] : []), ...LEGAL_LINKS];

/** Footer for public pages: Pricing, Privacy, Terms, Contact, GitHub. A tenant can drop Pricing and the GitHub link. */
export default function PublicFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="border-t border-line py-8 text-sm text-ink-muted">
      <div className="page !py-0 flex flex-col items-center gap-3 text-center">
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="rounded hover:text-ink">{l.label}</Link>
          ))}
          <a href={CONTACT_LINK.href} className="rounded hover:text-ink">{CONTACT_LINK.label}</a>
          {brand.showOssSections && <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="rounded hover:text-ink">GitHub</a>}
        </nav>
        {children}
      </div>
    </footer>
  );
}

import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legalLinks";
import { GITHUB_URL } from "@/lib/seo";

const LINKS = [{ href: "/pricing", label: "Pricing" }, ...LEGAL_LINKS];

/** Footer for public pages: Pricing, Privacy, Terms, GitHub. */
export default function PublicFooter({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="border-t border-line py-8 text-sm text-ink-muted">
      <div className="page !py-0 flex flex-col items-center gap-3 text-center">
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="rounded hover:text-ink">{l.label}</Link>
          ))}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="rounded hover:text-ink">GitHub</a>
        </nav>
        {children}
      </div>
    </footer>
  );
}

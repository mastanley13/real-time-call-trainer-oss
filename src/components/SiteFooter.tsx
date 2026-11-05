import Link from "next/link";
import FooterCredit from "@/components/FooterCredit";
import { CONTACT_LINK, LEGAL_LINKS } from "@/lib/legalLinks";

export default function SiteFooter() {
  return (
    <footer className="border-t border-line py-8 text-center text-sm text-ink-muted">
      <FooterCredit />
      <nav aria-label="Legal" className="mt-2 flex justify-center gap-4">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="underline underline-offset-2 hover:text-ink">{l.label}</Link>
        ))}
        <a href={CONTACT_LINK.href} className="underline underline-offset-2 hover:text-ink">{CONTACT_LINK.label}</a>
      </nav>
    </footer>
  );
}

import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legalLinks";

export default function LegalLinks() {
  return (
    <nav aria-label="Legal" className="mt-3 flex justify-center gap-4 text-xs text-ink-muted">
      {LEGAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="underline underline-offset-2 hover:text-ink">{l.label}</Link>
      ))}
    </nav>
  );
}

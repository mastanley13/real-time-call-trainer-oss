import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legalLinks";

export default function SiteFooter() {
  return (
    <footer className="border-t border-line py-8 text-center text-sm text-ink-muted">
      <p>MIT licensed · by Mykel Stanley · originally based on OpenAI&rsquo;s openai-realtime-agents demo</p>
      <nav aria-label="Legal" className="mt-2 flex justify-center gap-4">
        {LEGAL_LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="underline underline-offset-2 hover:text-ink">{l.label}</Link>
        ))}
      </nav>
    </footer>
  );
}

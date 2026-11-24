import Link from "next/link";
import { Compass, LibraryBig, PhoneCall } from "lucide-react";

export default function NotFound() {
  return (
    <div className="page py-16 sm:py-24">
      <div className="deck mx-auto max-w-xl overflow-hidden rounded-sheet border border-line p-6 shadow-pop sm:p-8">
        <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.1em] text-ink-muted">
          <span className="lamp lamp-off" aria-hidden />
          <span>404 · Route not found</span>
        </div>
        <div className="mt-5 flex items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-sunken text-ink-muted">
            <Compass size={20} strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold text-ink">That page does not exist</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Check the address, or jump straight back to the persona library or a practice call.
            </p>
          </div>
        </div>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/library" className="btn-primary">
            <LibraryBig size={16} strokeWidth={1.75} aria-hidden /> Open library
          </Link>
          <Link href="/trainer" className="btn-ghost">
            <PhoneCall size={16} strokeWidth={1.75} aria-hidden /> Start practice
          </Link>
          <Link href="/" className="btn-quiet">Go home</Link>
        </div>
      </div>
    </div>
  );
}

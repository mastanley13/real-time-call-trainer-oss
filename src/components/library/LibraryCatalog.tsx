import Link from "next/link";
import { Play } from "lucide-react";
import { DifficultyBars, PersonaAvatar } from "@/components/ui/Persona";
import { LIBRARY } from "@/lib/personas";
import { registerHref } from "@/lib/pricing";
import { signInHref } from "@/lib/safeNext";
import { JOB_FAMILIES, jobFamilyLabel, type Scenario } from "@/lib/scenarios";

/** Built-in personas only, grouped by job family in JOB_FAMILIES order. Never includes custom or private personas. */
export function catalogGroups(list: readonly Scenario[] = LIBRARY): { role: string; items: Scenario[] }[] {
  const order = [...JOB_FAMILIES.map((f) => f.id as string), ...new Set(list.map((s) => s.role))];
  const seen = new Set<string>();
  const out: { role: string; items: Scenario[] }[] = [];
  for (const role of order) {
    if (seen.has(role)) continue;
    seen.add(role);
    const items = list.filter((s) => s.builtIn && s.role === role);
    if (items.length) out.push({ role, items });
  }
  return out;
}

/** Where a signed-out reader goes to practice a persona: sign in, then land on the trainer with it picked. */
export function practiceHref(id: string): string {
  return signInHref(`/trainer?scenario=${encodeURIComponent(id)}`);
}

/**
 * The server-rendered persona index: in the initial HTML for crawlers and signed-out readers. Signed-in users
 * get the interactive LibraryClient on top once it hydrates.
 */
export default function LibraryCatalog() {
  const groups = catalogGroups();
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="page enter">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold sm:text-4xl">Persona library</h1>
          <p className="mt-2 font-mono text-[12px] text-ink-muted"><span className="text-ink">{total}</span> personas across <span className="text-ink">{groups.length}</span> sales jobs · open source, add your own as a pack file</p>
          <p className="mt-3 max-w-[62ch] text-ink-soft">AI buyers who push back, grouped by sales job. Pick one, read the briefing and practice the call with a live coach and a graded debrief.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={signInHref("/library")} className="btn-ghost">Sign in</Link>
          <Link href={registerHref({ src: "library" })} className="btn-primary">Start free, no card</Link>
        </div>
      </div>

      <nav aria-label="Sales jobs" className="mt-6 flex flex-wrap gap-1.5">
        {groups.map((g) => <a key={g.role} href={`#fam-${g.role}`} className="chip min-h-[28px] hover:border-ink-muted">{jobFamilyLabel(g.role)} <span className="mono text-[10px] text-ink-muted">{g.items.length}</span></a>)}
      </nav>

      <div className="mt-8 space-y-10">
        {groups.map((g) => (
          <section key={g.role} aria-labelledby={`fam-${g.role}`}>
            <h2 id={`fam-${g.role}`} className="mb-3 scroll-mt-24 text-lg font-bold">{jobFamilyLabel(g.role)} <span className="mono ml-1 text-sm font-medium text-ink-muted">{g.items.length}</span></h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.items.map((s) => (
                <li key={s.id} className="flex min-w-0 flex-col rounded-panel border border-line bg-surface p-4 shadow-card">
                  <div className="flex items-start gap-3">
                    <PersonaAvatar scenario={s} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="truncate font-heading text-[15px] font-bold">{s.aiPersona.name}</h3>
                        <DifficultyBars level={s.difficulty} showLabel={false} />
                      </div>
                      <p className="text-[13px] leading-snug text-ink-soft">{s.aiPersona.role}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm">{s.title}</p>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
                    <span className="min-w-0 truncate text-[12px] text-ink-muted">{s.industry || "General"}</span>
                    <Link href={practiceHref(s.id)} className="btn-primary btn-sm !min-h-[36px] shrink-0" aria-label={`Practice ${s.title}`}><Play size={13} strokeWidth={1.75} aria-hidden /> Practice</Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

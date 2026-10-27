import type { Scenario } from "@/lib/scenarios";

/** Indexes into the categorical tokens --cat-1 to --cat-8 (globals.css), in the order avatars have always used. */
const HUES = [1, 2, 4, 3, 5, 6, 7, 8];
function hueFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `--cat-${HUES[h % HUES.length]}`;
}
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

/** Monogram in an instrument ring, tinted per persona so cards are scannable. */
export function PersonaAvatar({ scenario, size = 44, className = "" }: { scenario: Pick<Scenario, "id" | "aiPersona">; size?: number; className?: string }) {
  const hue = hueFor(scenario.id);
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full bg-sunken font-heading font-bold text-ink ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.34, boxShadow: `inset 0 0 0 2px rgb(var(${hue}) / 0.4), 0 0 0 1px rgb(var(--line))` }}
      aria-hidden
    >
      {initials(scenario.aiPersona.name)}
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface" style={{ background: `rgb(var(${hue}))` }} />
    </span>
  );
}

const DIFF = { easy: 1, medium: 2, hard: 3 } as const;
/** Three-segment difficulty gauge with a text label, so color is never the only signal.
 *  The level is real text (sr-only when hidden) because aria-label on a plain span is ignored by screen readers. */
export function DifficultyBars({ level, showLabel = true }: { level: Scenario["difficulty"]; showLabel?: boolean }) {
  const n = DIFF[level];
  const tone = n === 3 ? "bg-alert" : n === 2 ? "bg-caution" : "bg-ok";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex items-end gap-0.5" aria-hidden>
        {[1, 2, 3].map((i) => <span key={i} className={`w-1 rounded-sm ${i <= n ? tone : "bg-line"}`} style={{ height: 4 + i * 3 }} />)}
      </span>
      {showLabel
        ? <span className="font-mono text-[11px] capitalize text-ink-muted"><span className="sr-only">Difficulty: </span>{level}</span>
        : <span className="sr-only">Difficulty: {level}</span>}
    </span>
  );
}

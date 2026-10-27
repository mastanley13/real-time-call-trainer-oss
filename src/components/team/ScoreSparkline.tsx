import { LOW_SCORE, scoreBand } from "@/lib/team";

const DOT = { ok: "fill-ok", signal: "fill-signal", caution: "fill-caution", none: "fill-ink-muted" } as const;

/** Recent scores on a fixed 0 to 100 scale. The values are read out for screen readers, and a dashed line marks the coaching threshold. */
export default function ScoreSparkline({ values, className = "h-7 w-24" }: { values: number[]; className?: string }) {
  if (values.length < 2) {
    return <span className="font-mono text-[11px] text-ink-muted">{values.length ? "1 score so far" : "No scores"}</span>;
  }
  const w = 96, h = 28;
  const y = (v: number) => h - 3 - (v / 100) * (h - 6);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, y(v)] as const);
  const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`overflow-visible ${className}`} role="img"
      aria-label={`Last ${values.length} scores, oldest first: ${values.join(", ")}`}>
      <line x1="0" x2={w} y1={y(LOW_SCORE)} y2={y(LOW_SCORE)} className="stroke-line" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" className="stroke-primary" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2.5" className={DOT[scoreBand(values[values.length - 1])]} />
    </svg>
  );
}

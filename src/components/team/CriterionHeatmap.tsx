import { Grid3x3 } from "lucide-react";
import { BAND_LABEL, scoreBand, type ScoreBand, type TeamMatrix } from "@/lib/team";

/** Fills come from tokens; the number is always printed, so colour is never the only signal. */
export const CELL: Record<ScoreBand, string> = {
  ok: "bg-ok-soft text-ok",
  signal: "bg-signal/15 text-ink",
  caution: "bg-caution-soft text-caution",
  none: "bg-sunken text-ink-muted",
};
const LEGEND: { band: ScoreBand; range: string }[] = [
  { band: "ok", range: "80 and up" },
  { band: "signal", range: "60 to 79" },
  { band: "caution", range: "under 60" },
  { band: "none", range: "no graded calls" },
];

/** Rep-by-criterion matrix. Scrolls inside its own container on phones, with the rep column pinned. */
export default function CriterionHeatmap({ matrix, days }: { matrix: TeamMatrix; days: number }) {
  if (!matrix.criteria.length || !matrix.rows.length) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line p-4 text-sm text-ink-soft">
        <Grid3x3 size={18} strokeWidth={1.75} className="shrink-0 text-ink-muted" aria-hidden />
        Criterion scores show up here once reps finish graded calls in the last {days} days.
      </div>
    );
  }
  return (
    <>
      {/* relative keeps sr-only (absolute) text inside the scroller so it cannot widen the page on phones. */}
      <div className="scroll-thin relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[640px] border-separate border-spacing-1 text-sm">
          <caption className="sr-only">Average score by rubric criterion for each rep over the last {days} days. Cells without graded calls say no data.</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-surface pb-1 pr-3 text-left align-bottom"><span className="label !mb-0">Rep</span></th>
              {matrix.criteria.map((c) => (
                <th key={c} scope="col" className="min-w-[84px] px-1 pb-1 text-left align-bottom text-[11px] font-medium leading-tight text-ink-muted">
                  <span className="line-clamp-2">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.repId}>
                <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-surface pr-3 text-left text-[13px] font-medium">{r.name}</th>
                {r.cells.map((v, i) => {
                  const band = scoreBand(v);
                  const n = r.counts[i];
                  return (
                    <td key={matrix.criteria[i]} className="p-0">
                      <span title={v === null ? `${matrix.criteria[i]}: no graded calls` : `${matrix.criteria[i]}: ${v} average over ${n} call${n === 1 ? "" : "s"} (${BAND_LABEL[band]})`}
                        className={`flex h-10 items-center justify-center rounded-md ${CELL[band]}`}>
                        {v === null ? <span className="text-[10px]">no data</span> : <span className="mono text-sm font-semibold">{v}</span>}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10.5px] text-ink-muted" aria-label="Colour key">
        {LEGEND.map((l) => (
          <li key={l.band} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-[3px] ${CELL[l.band]}`} aria-hidden />
            {BAND_LABEL[l.band]} · {l.range}
          </li>
        ))}
      </ul>
    </>
  );
}

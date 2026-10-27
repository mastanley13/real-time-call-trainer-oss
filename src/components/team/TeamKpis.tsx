import { BAND_LABEL, scoreBand, type TeamKpis as Kpis } from "@/lib/team";

const TAPE = { ok: "bg-ok", signal: "bg-signal", caution: "bg-caution", none: "bg-line" } as const;

/** Team KPI row: active reps, sessions, average score and persona coverage, in mono numerals. */
export default function TeamKpis({ kpis, days }: { kpis: Kpis; days: number }) {
  const band = scoreBand(kpis.avgScore);
  const activePct = kpis.totalReps ? Math.round((kpis.activeReps / kpis.totalReps) * 100) : 0;
  const tiles = [
    { label: "Active reps", value: String(kpis.activeReps), of: `of ${kpis.totalReps}`, caption: `practised in the last ${days} days`, fill: activePct, tone: "bg-primary" },
    { label: "Sessions", value: String(kpis.sessions), of: "", caption: `practice calls in the last ${days} days`, fill: null, tone: "" },
    { label: "Average score", value: kpis.avgScore === null ? "None" : String(kpis.avgScore), of: kpis.avgScore === null ? "" : "/ 100", caption: kpis.avgScore === null ? "no graded calls yet" : BAND_LABEL[band], fill: kpis.avgScore, tone: TAPE[band] },
    { label: "Persona coverage", value: String(kpis.coverage.practised), of: `of ${kpis.coverage.library}`, caption: `library personas practised (${kpis.coverage.pct}%)`, fill: kpis.coverage.pct, tone: "bg-primary" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="panel flex flex-col p-4">
          <p className="label !mb-1">{t.label}</p>
          <p className="flex items-baseline gap-1.5">
            <span className="mono text-3xl font-semibold">{t.value}</span>
            {t.of && <span className="mono text-sm text-ink-muted">{t.of}</span>}
          </p>
          <div className="mt-auto pt-3">
            {t.fill !== null ? <div className="tape" aria-hidden><span className={t.tone} style={{ width: `${Math.max(2, t.fill)}%` }} /></div> : <div className="h-1.5" aria-hidden />}
            <p className="mt-1.5 font-mono text-[10px] text-ink-muted">{t.caption}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

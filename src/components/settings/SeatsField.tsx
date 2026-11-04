import { SEATS_HELP } from "@/lib/billingUi";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/usagePlan";

/**
 * The Team seats box. The help line is always there. When leaving the box below the minimum sets it back, `note` says so
 * in a status region that is always in the page, so a screen reader announces it when its text appears, and
 * aria-describedby points at it while it has text. The focus ring is an explicit 2px outline: `.input` drops the outline
 * and keeps only a border change and a faint ring.
 */
export default function SeatsField({ value, note, disabled, onChange, onBlur }: {
  value: string;
  note: string | null;
  disabled?: boolean;
  onChange: (text: string) => void;
  onBlur: () => void;
}) {
  return (
    <div>
      <label className="label" htmlFor="seats">Seats</label>
      <input
        id="seats"
        className="input w-24 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        type="number"
        inputMode="numeric"
        min={TEAM_MIN_SEATS}
        max={TEAM_MAX_SEATS}
        value={value}
        disabled={disabled}
        aria-describedby={note ? "seats-help seats-note" : "seats-help"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <p id="seats-help" className="mt-1 text-xs text-ink-muted">{SEATS_HELP}</p>
      <p id="seats-note" role="status" aria-live="polite" className="mt-1 text-xs font-medium text-ink">{note ?? ""}</p>
    </div>
  );
}

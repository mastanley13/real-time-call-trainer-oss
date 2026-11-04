import { PREMIUM_COMING_SOON } from "@/lib/pricing";

/**
 * The Premium AI voice control on the billing page. Premium is off sale, so it is never checkable and never sent
 * (checkout always posts premium:false). It renders in both billing states, outside the purchase section.
 */
export default function PremiumVoiceControl() {
  return (
    <label className="panel flex items-center gap-2 p-4 text-sm text-ink-muted">
      <input type="checkbox" checked={false} disabled readOnly />
      Premium AI voice: {PREMIUM_COMING_SOON}
    </label>
  );
}

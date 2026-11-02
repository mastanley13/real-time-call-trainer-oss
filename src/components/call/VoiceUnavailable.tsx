import { VOICE_UNAVAILABLE_MESSAGE } from "@/lib/billingUi";

export const VOICE_UNAVAILABLE_ID = "voice-unavailable";

/**
 * Shown in Voice mode when the usage lookup failed, so voice fails closed. It is the visible reason the Start button
 * is disabled (the button points at it with aria-describedby) and offers the way out: the text sim, which stays open.
 */
export default function VoiceUnavailable({ onUseText }: { onUseText: () => void }) {
  return (
    <div id={VOICE_UNAVAILABLE_ID} role="status" className="rounded-panel border border-alert/40 bg-alert-soft p-3 text-sm">
      <p>{VOICE_UNAVAILABLE_MESSAGE}</p>
      <button type="button" className="btn-ghost btn-sm mt-2" onClick={onUseText}>Switch to text practice</button>
    </div>
  );
}

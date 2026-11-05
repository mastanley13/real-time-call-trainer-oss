"use client";

import { useEffect, useState } from "react";
import { Check, Info, Loader2, Lock, Mic } from "lucide-react";
import { radioKeys } from "@/components/call/CopilotRail";
import { VOICE_TIERS, VOICE_TIER_LABELS, effectiveVoiceTier, normalizeVoiceTier, type VoiceTier } from "@/lib/voiceTier";

const HELP: Record<VoiceTier, string> = {
  standard: "Standard fits everyday practice and costs the least per call.",
  premium: "Premium runs a larger voice model for more natural calls. Each call costs more.",
};

/**
 * Voice quality for the team's voice calls. Label and description on the left, control on the right
 * (Linear Preferences and Vercel project settings rows). Saves on change.
 *
 * Shown only where it means something: to everyone on a comped team (read-only unless they can edit),
 * and to platform admins on any team. Teams that are not comped always run Standard and see nothing here.
 */
export default function VoicePanel() {
  const [tier, setTier] = useState<VoiceTier | null>(null);
  const [comped, setComped] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState<VoiceTier | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/team/voice")
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live || !r.ok || body.local) return;
        setTier(normalizeVoiceTier(body.tier));
        setComped(body.comped === true);
        setCanEdit(body.canEdit === true);
      })
      .catch(() => { /* leave the panel hidden */ });
    return () => { live = false; };
  }, []);

  if (!tier || (!canEdit && !comped)) return null;
  const effective = effectiveVoiceTier(tier, comped);

  async function choose(next: VoiceTier) {
    if (!canEdit || saving || next === tier) return;
    const prev = tier;
    setTier(next);
    setSaving(next);
    setSaved(false);
    setError("");
    try {
      const r = await fetch("/api/team/voice", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: next }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Could not save voice quality. Try again in a minute.");
      setTier(normalizeVoiceTier(body.tier));
      if (typeof body.comped === "boolean") setComped(body.comped);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setTier(prev);
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="voice-h">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="voice-h" className="flex items-center gap-2 text-sm font-bold"><Mic size={16} strokeWidth={1.75} aria-hidden /> Voice quality</h2>
          <p id="voice-help" className="mt-1 text-sm text-ink-muted">{HELP[tier]} Applies to new voice calls for everyone on this team.</p>
          {!comped && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-soft">
              <Info size={14} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden />
              <span>Platform admin view. Premium voice quality is not enabled for this team, so calls use Standard whatever you pick here.</span>
            </p>
          )}
        </div>
        <div className="w-full shrink-0 sm:w-auto">
          <div role="radiogroup" aria-label="Voice quality" aria-describedby="voice-help" aria-disabled={!canEdit || undefined}
            className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1 sm:w-64"
            onKeyDown={canEdit && !saving ? radioKeys(VOICE_TIERS, tier, (t) => void choose(t)) : undefined}>
            {VOICE_TIERS.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={tier === t} tabIndex={tier === t ? 0 : -1}
                disabled={!canEdit || (!!saving && saving !== t)} onClick={() => void choose(t)}
                className={`flex min-h-[38px] items-center justify-center gap-2 rounded-md text-sm font-semibold transition disabled:cursor-not-allowed ${tier === t ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted enabled:hover:text-ink"}`}>
                {saving === t && <Loader2 size={14} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                {VOICE_TIER_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="mt-2 min-h-[1.25rem] text-xs" role="status" aria-live="polite">
            {saved && <p className="flex items-center gap-1.5 text-ink-soft"><Check size={14} strokeWidth={1.75} className="text-ok" aria-hidden /> Saved. The next voice call uses {VOICE_TIER_LABELS[effective]}.</p>}
            {!canEdit && <p className="flex items-center gap-1.5 text-ink-muted"><Lock size={14} strokeWidth={1.75} aria-hidden /> Only the team owner can change this.</p>}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg border border-alert/40 bg-alert-soft p-3 text-sm">{error}</p>}
    </section>
  );
}

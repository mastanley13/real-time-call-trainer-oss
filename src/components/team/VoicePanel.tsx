"use client";

import { useEffect, useState } from "react";
import { Check, Info, Loader2, Mic } from "lucide-react";
import { radioKeys } from "@/components/call/CopilotRail";
import { VOICE_TIERS, VOICE_TIER_LABELS, normalizeVoiceTier, type VoiceTier } from "@/lib/voiceTier";

const HELP: Record<VoiceTier, string> = {
  standard: "Standard fits everyday practice and costs the least per call.",
  premium: "Premium runs a larger voice model for more natural calls. Each call costs more.",
};

/** What GET and PATCH /api/team/voice answer. `tier` is the effective tier; `selected` is the stored choice. */
export type VoiceView = { tier: VoiceTier; selected: VoiceTier; comped: boolean; canEdit: boolean };

/** Reads an /api/team/voice body. `selected` is sent only to editors; without it the choice is the effective tier. */
export function parseVoiceView(body: unknown): VoiceView | null {
  if (!body || typeof body !== "object" || (body as { local?: unknown }).local) return null;
  const b = body as { tier?: unknown; selected?: unknown; comped?: unknown; canEdit?: unknown };
  const tier = normalizeVoiceTier(b.tier);
  return { tier, selected: b.selected === undefined ? tier : normalizeVoiceTier(b.selected), comped: b.comped === true, canEdit: b.canEdit === true };
}

/**
 * Voice quality for the team's voice calls. Label and description on the left, control on the right
 * (Linear Preferences and Vercel project settings rows). Saves on change.
 *
 * Shown only to people who can change it: the owner of a comped team, and platform admins on any team.
 * Everyone else (managers, trainees, owners of a team that is not comped) sees nothing at all, not a
 * disabled or read-only control; their calls simply run on the team's effective tier.
 */
export default function VoicePanel() {
  const [view, setView] = useState<VoiceView | null>(null);
  const [saving, setSaving] = useState<VoiceTier | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/team/voice")
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (live && r.ok) setView(parseVoiceView(body));
      })
      .catch(() => { /* leave the panel hidden */ });
    return () => { live = false; };
  }, []);

  async function choose(next: VoiceTier) {
    if (!view?.canEdit || saving || next === view.selected) return;
    const prev = view;
    setView({ ...view, selected: next });
    setSaving(next);
    setSaved(false);
    setError("");
    try {
      const r = await fetch("/api/team/voice", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier: next }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || "Could not save voice quality. Try again in a minute.");
      setView(parseVoiceView(body) ?? prev);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setView(prev);
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not reach the server. Check your connection and try again.");
    } finally {
      setSaving(null);
    }
  }

  return <VoicePanelView view={view} saving={saving} saved={saved} error={error} onChoose={(t) => void choose(t)} />;
}

/** The panel itself, with no data loading, so it can be rendered on its own (tests/voice-panel.test.ts). */
export function VoicePanelView({ view, saving = null, saved = false, error = "", onChoose }: {
  view: VoiceView | null;
  saving?: VoiceTier | null;
  saved?: boolean;
  error?: string;
  onChoose: (tier: VoiceTier) => void;
}) {
  // No editor, no panel: not disabled, not read-only, not rendered.
  if (!view || !view.canEdit) return null;
  const { selected, tier: effective, comped } = view;

  return (
    <section className="panel p-4 sm:p-5" aria-labelledby="voice-h">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="voice-h" className="flex items-center gap-2 text-sm font-bold"><Mic size={16} strokeWidth={1.75} aria-hidden /> Voice quality</h2>
          <p id="voice-help" className="mt-1 text-sm text-ink-muted">{HELP[selected]} Applies to new voice calls for everyone on this team.</p>
          {!comped && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-soft">
              <Info size={14} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden />
              <span>Platform admin view. Premium voice quality is not enabled for this team, so calls use Standard whatever you pick here.</span>
            </p>
          )}
        </div>
        <div className="w-full shrink-0 sm:w-auto">
          <div role="radiogroup" aria-label="Voice quality" aria-describedby="voice-help"
            className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1 sm:w-64"
            onKeyDown={!saving ? radioKeys(VOICE_TIERS, selected, onChoose) : undefined}>
            {VOICE_TIERS.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={selected === t} tabIndex={selected === t ? 0 : -1}
                disabled={!!saving && saving !== t} onClick={() => onChoose(t)}
                className={`flex min-h-[38px] items-center justify-center gap-2 rounded-md text-sm font-semibold transition disabled:cursor-not-allowed ${selected === t ? "bg-surface text-ink shadow-card ring-1 ring-line" : "text-ink-muted enabled:hover:text-ink"}`}>
                {saving === t && <Loader2 size={14} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                {VOICE_TIER_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="mt-2 min-h-[1.25rem] text-xs" role="status" aria-live="polite">
            {saved && <p className="flex items-center gap-1.5 text-ink-soft"><Check size={14} strokeWidth={1.75} className="text-ok" aria-hidden /> Saved. The next voice call uses {VOICE_TIER_LABELS[effective]}.</p>}
          </div>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg border border-alert/40 bg-alert-soft p-3 text-sm">{error}</p>}
    </section>
  );
}

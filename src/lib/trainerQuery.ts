/** Pure readers for the /trainer query string. Client-safe. */

/**
 * True only for ?mode=text exactly. Sign-up from /try/[role] lands on /trainer?scenario=<id>&mode=text so the rep starts
 * in the text call. Any other value, or no mode at all, leaves the trainer's own default alone.
 */
export function wantsTextMode(q: { get(name: string): string | null }): boolean {
  return q.get("mode") === "text";
}

/** Where the briefing remembers the rep's explicit Voice or Text pick in this browser. */
export const CALL_MODE_KEY = "rtct.callMode";

/**
 * The call mode the briefing opens on. ?mode=text wins. Then an explicit saved pick (voice or text) is kept. Without one,
 * a rep who has practiced in this browser before (a last persona is stored when a call starts) keeps the old Voice
 * default, and a first-time rep starts in Text, which needs no mic and no voice minutes.
 */
export function initialCallMode(input: { textParam: boolean; saved: string | null; hasPracticed: boolean }): "voice" | "text" {
  if (input.textParam) return "text";
  if (input.saved === "voice" || input.saved === "text") return input.saved;
  return input.hasPracticed ? "voice" : "text";
}

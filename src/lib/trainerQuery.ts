/** Pure readers for the /trainer query string. Client-safe. */

/**
 * True only for ?mode=text exactly. Sign-up from /try/[role] lands on /trainer?scenario=<id>&mode=text so the rep starts
 * in the text call. Any other value, or no mode at all, leaves the trainer's own default alone.
 */
export function wantsTextMode(q: { get(name: string): string | null }): boolean {
  return q.get("mode") === "text";
}

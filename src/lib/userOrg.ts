/** Pure helper for the /api/me team-name backfill, kept out of AuthContext so it can be tested without a browser. */

export type Org = { id: string; name: string; code?: string | null };

/**
 * Applies a looked-up organization to the current user, or returns `current` untouched when the
 * answer is stale: no user, a different user than the one the lookup was for, or an organization
 * already recorded (a login or register finished while the request was pending).
 * `null` means "looked up, no team", stored so the lookup is not repeated on every page load.
 */
export function backfillOrganization<U extends { id: string; organization?: Org | null }>(
  current: U | null,
  expectedId: string,
  org: Org | null | undefined,
): U | null {
  if (!current || current.id !== expectedId || current.organization !== undefined) return current;
  if (org === undefined) return current;
  if (org === null) return { ...current, organization: null };
  if (typeof org.name !== "string") return current;
  return { ...current, organization: { id: org.id, name: org.name, code: org.code ?? null } };
}

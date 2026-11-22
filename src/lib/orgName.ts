/** Longest Organization.name the register route accepts. */
export const ORG_NAME_MAX = 120;

/**
 * The org name for a rep who signs up without a team name: "<firstName>'s workspace".
 * Pure and client-safe. Falls back to "My workspace" when the first name is blank.
 */
export function defaultOrgName(firstName: string | null | undefined): string {
  const first = (firstName ?? "").trim();
  if (!first) return "My workspace";
  const suffix = "'s workspace";
  return `${first.slice(0, ORG_NAME_MAX - suffix.length)}${suffix}`;
}

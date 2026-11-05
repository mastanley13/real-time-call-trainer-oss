/**
 * The header AI status chip is for self-host builds and platform admins. A hosted build (paid plans are configured on
 * the server) hides it from everyone else. It says that AI is on, never which model. Display only: /settings/models and
 * /api/llm/check still enforce their own access.
 */
export function showModelChip(
  capabilities: { hosted?: boolean; llm: boolean } | null,
  user: { isPlatformAdmin?: boolean } | null,
): boolean {
  if (!capabilities?.llm) return false;
  return !capabilities.hosted || !!user?.isPlatformAdmin;
}

/** The chip text. A neutral label: model ids stay on the server. */
export const AI_CHIP_LABEL = "AI on";

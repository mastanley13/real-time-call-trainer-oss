/**
 * The header model chip is for self-host builds and platform admins. A hosted build (paid plans are configured on the
 * server) hides it from everyone else. Display only: /settings/models and /api/llm/check still enforce their own access.
 */
export function showModelChip(
  capabilities: { hosted?: boolean; model?: string; llm: boolean } | null,
  user: { isPlatformAdmin?: boolean } | null,
): boolean {
  if (!capabilities?.model || !capabilities.llm) return false;
  return !capabilities.hosted || !!user?.isPlatformAdmin;
}

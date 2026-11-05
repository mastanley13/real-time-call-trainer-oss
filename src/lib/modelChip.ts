/**
 * The header AI status chip ("AI coach", linking to /settings/models) is for self-host builds and platform admins. A
 * hosted build (paid plans are configured on the server) hides it from everyone else. It never shows a model id:
 * /api/config does not send one. Display only: /settings/models and /api/llm/check still enforce their own access.
 */
export function showModelChip(
  capabilities: { hosted?: boolean; llm: boolean } | null,
  user: { isPlatformAdmin?: boolean } | null,
): boolean {
  if (!capabilities?.llm) return false;
  return !capabilities.hosted || !!user?.isPlatformAdmin;
}

import "server-only";

type Level = "info" | "warn" | "error";

/** Allowed log fields. No email, name, token, URL or provider body ever goes through here. */
type Fields = { userId?: string; event?: string; status?: number; attempt?: number; field?: string; key?: string; count?: number; outcome?: string };

/** One JSON line per entry, so the logs stay structured and greppable. */
export function ghlLog(level: Level, msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({ scope: "ghl", level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

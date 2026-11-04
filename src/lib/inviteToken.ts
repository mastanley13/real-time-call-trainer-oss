import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { siteUrl } from "./seo";

/** 32 random bytes, base64url: 43 characters, matching INVITE_TOKEN_RE. Shown once, in the link; never stored. */
export const newInviteToken = () => randomBytes(32).toString("base64url");

/** What the database keeps instead of the token. */
export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** APP_URL when set, else the origin the owner is using, so a local or preview install hands out working links. */
export function inviteLink(token: string, requestOrigin: string): string {
  const origin = process.env.APP_URL?.trim() ? siteUrl() : requestOrigin;
  return `${origin}/invite/${token}`;
}

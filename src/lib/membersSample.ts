/**
 * A made-up Members page for demo mode and installs without a database. Names and addresses are fictional.
 * `default` has a free seat, a pending invite and an expired one; `full` has every seat taken.
 * The payload carries `sample: true` and the page labels it.
 */
import { INVITE_TTL_MS, payloadSeats, sortInvites, type InviteView, type MemberView, type MembersPayload } from "./invites";
import { SAMPLE_ORG } from "./teamSample";

const DAY = 86_400_000;
export type SampleMembersVariant = "default" | "full";
export const sampleVariant = (raw: string | null | undefined): SampleMembersVariant => (raw === "full" ? "full" : "default");

const iso = (t: number) => new Date(t).toISOString();

export function buildSampleMembers(variant: SampleMembersVariant, now: Date, viewer: { id: string; name: string; email: string }): MembersPayload {
  const t = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const member = (id: string, name: string, email: string, role: MemberView["role"], days: number): MemberView => ({ id, name, email, role, joinedAt: iso(t - days * DAY) });
  const invite = (id: string, email: string, sentDaysAgo: number, role: InviteView["role"] = "trainee"): InviteView => {
    const sent = t - sentDaysAgo * DAY;
    const expires = sent + INVITE_TTL_MS;
    return { id, email, role, status: expires > now.getTime() ? "pending" : "expired", sentAt: iso(sent), expiresAt: iso(expires) };
  };

  const members: MemberView[] = [
    member(viewer.id, viewer.name, viewer.email, "owner", 120),
    member("sample-rep-jordan", "Jordan Lee", "jordan.lee@harborpoint.example", "manager", 96),
    member("sample-rep-priya", "Priya Raman", "priya.raman@harborpoint.example", "trainee", 64),
  ];
  const invites: InviteView[] = [
    invite("sample-invite-marcus", "marcus.bell@harborpoint.example", 2),
    invite("sample-invite-luis", "luis.moreno@harborpoint.example", 11),
  ];
  if (variant === "full") {
    members.push(member("sample-rep-sofia", "Sofia Alvarez", "sofia.alvarez@harborpoint.example", "trainee", 30));
  }

  const org = { name: SAMPLE_ORG.name, seatCount: 5, planTier: "team" };
  return { org, access: "manage", viewerId: viewer.id, members, invites: sortInvites(invites), seats: payloadSeats({ members, invites, org }), sample: true };
}

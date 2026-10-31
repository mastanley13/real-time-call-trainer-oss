import { z } from "zod";

/** Lifecycle events the app reports to GoHighLevel. Pure and safe on both sides. */
export const GHL_EVENTS = ["signup", "first_graded_call", "active_trial", "upgrade", "went_quiet"] as const;
export type GhlEvent = (typeof GHL_EVENTS)[number];

export const GHL_SEGMENTS = ["insurance", "solar", "home-services", "saas", "staffing"] as const;
export type GhlSegment = (typeof GHL_SEGMENTS)[number];

export const GHL_PIPELINE = "Inbound Trials";

export const GHL_STAGES: Record<GhlEvent, string> = {
  signup: "Signed Up",
  first_graded_call: "First Graded Call",
  active_trial: "Active Trial",
  upgrade: "Upgraded (Paid)",
  went_quiet: "Went Quiet",
};

/** Logical custom field keys. Resolved to GHL field ids by `fieldKey` ("contact.<key>") once and cached. */
export const GHL_FIELD_KEYS = [
  "plan",
  "signup_date",
  "minute_cap",
  "voice_minutes_used",
  "last_active_date",
  "inbound_source",
  "referred_by_partner",
  "first_graded_call_date",
  "stripe_customer_id",
] as const;
export type GhlFieldKey = (typeof GHL_FIELD_KEYS)[number];

/** The JSON posted to GHL_INBOUND_WEBHOOK_URL, and the input to the API transport. */
export const GhlPayloadSchema = z.object({
  event: z.enum(GHL_EVENTS),
  occurredAt: z.string().max(40),
  user: z.object({ id: z.string().max(128), email: z.string().max(254), firstName: z.string().max(80) }),
  plan: z.string().max(40),
  segment: z.enum(GHL_SEGMENTS).nullable(),
  minuteCap: z.number().int().nonnegative(),
  voiceMinutesUsed: z.number().nonnegative(),
  source: z.string().max(120).nullable(),
  referredByPartner: z.string().max(120).nullable(),
  stripeCustomerId: z.string().max(120).nullable(),
});
export type GhlPayload = z.infer<typeof GhlPayloadSchema>;

export type GhlActions = {
  stage: string;
  addTags: string[];
  removeTags: string[];
  fields: Partial<Record<GhlFieldKey, string | number>>;
};

const day = (iso: string) => iso.slice(0, 10);

/**
 * What each event does in GHL. `segment` becomes a seg-<x> tag only when the payload carries one,
 * and the caller must pass a segment the user confirmed, never one inferred from a persona or page.
 * Nothing here sends email or SMS.
 */
export function actionsFor(p: GhlPayload): GhlActions {
  const lastActive = day(p.occurredAt);
  switch (p.event) {
    case "signup":
      return {
        stage: GHL_STAGES.signup,
        addTags: ["ct-trial", ...(p.segment ? [`seg-${p.segment}`] : [])],
        removeTags: [],
        fields: {
          plan: p.plan,
          signup_date: day(p.occurredAt),
          minute_cap: p.minuteCap,
          voice_minutes_used: 0,
          last_active_date: lastActive,
          inbound_source: p.source ?? "",
          referred_by_partner: p.referredByPartner ?? "",
        },
      };
    case "first_graded_call":
      return {
        stage: GHL_STAGES.first_graded_call,
        addTags: ["ct-activated"],
        removeTags: [],
        fields: { first_graded_call_date: day(p.occurredAt), voice_minutes_used: p.voiceMinutesUsed, last_active_date: lastActive },
      };
    case "active_trial":
      return {
        stage: GHL_STAGES.active_trial,
        addTags: [],
        removeTags: [],
        fields: { voice_minutes_used: p.voiceMinutesUsed, last_active_date: lastActive },
      };
    case "upgrade":
      return {
        stage: GHL_STAGES.upgrade,
        addTags: [p.plan === "team" ? "ct-paid-team" : "ct-paid-pro"],
        removeTags: [],
        fields: { plan: p.plan, minute_cap: p.minuteCap, stripe_customer_id: p.stripeCustomerId ?? "" },
      };
    case "went_quiet":
      // ct-trial stays on the contact, so nothing is removed.
      return { stage: GHL_STAGES.went_quiet, addTags: [], removeTags: [], fields: { last_active_date: lastActive } };
  }
}

/** Events that can legitimately repeat for one user carry a date suffix so the key still dedupes retries. */
const REPEATABLE: ReadonlySet<GhlEvent> = new Set(["active_trial", "went_quiet"]);

/** "<userId>:<event>", plus ":<YYYY-MM-DD>" for events that can fire again after a quiet spell. */
export function idempotencyKey(userId: string, event: GhlEvent, occurredAt: string): string {
  return REPEATABLE.has(event) ? `${userId}:${event}:${day(occurredAt)}` : `${userId}:${event}`;
}

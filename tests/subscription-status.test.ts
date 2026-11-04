import { describe, expect, it } from "vitest";
import {
  CHECKOUT_BLOCKING_STATUSES, DEFAULT_PAST_DUE_GRACE_DAYS, PAST_DUE_GRACE_DAYS, blocksCheckout, inPastDueGrace, isEntitled, nextPastDueSince,
  parseGraceDays, storedPlanEntitled,
} from "@/lib/subscriptionStatus";
import {
  ACTIVE_NOTICE, INCOMPLETE_NOTICE, PAST_DUE_NOTICE, PAUSED_NOTICE, UNPAID_NOTICE, checkoutNotice,
} from "@/lib/billingUi";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-03T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("isEntitled", () => {
  it("grants active and trialing", () => {
    expect(isEntitled("active", null, NOW)).toBe(true);
    expect(isEntitled("trialing", null, NOW)).toBe(true);
  });

  it("never grants unpaid, paused, incomplete, incomplete_expired, canceled, unknown or missing statuses", () => {
    for (const status of ["unpaid", "paused", "incomplete", "incomplete_expired", "canceled", "weird", "", null, undefined]) {
      expect(isEntitled(status, null, NOW), String(status)).toBe(false);
      // A leftover pastDueSince does not revive them.
      expect(isEntitled(status, daysAgo(1), NOW), String(status)).toBe(false);
    }
  });

  it("past_due is entitled on day 6 and not on day 8, with the default 7 day grace", () => {
    expect(isEntitled("past_due", daysAgo(0), NOW)).toBe(true);
    expect(isEntitled("past_due", daysAgo(6), NOW)).toBe(true);
    expect(isEntitled("past_due", daysAgo(8), NOW)).toBe(false);
  });

  it("the grace window ends exactly at the configured length", () => {
    expect(isEntitled("past_due", new Date(NOW.getTime() - 7 * DAY + 1), NOW)).toBe(true);
    expect(isEntitled("past_due", daysAgo(7), NOW)).toBe(false);
  });

  it("past_due with no known start is inside grace", () => {
    expect(isEntitled("past_due", null, NOW)).toBe(true);
    expect(isEntitled("past_due", undefined, NOW)).toBe(true);
    expect(inPastDueGrace(null, NOW)).toBe(true);
  });

  it("honors an explicit grace length, including zero", () => {
    expect(isEntitled("past_due", daysAgo(2), NOW, 3)).toBe(true);
    expect(isEntitled("past_due", daysAgo(4), NOW, 3)).toBe(false);
    expect(isEntitled("past_due", daysAgo(0), NOW, 0)).toBe(false);
  });
});

describe("PAST_DUE_GRACE_DAYS env override", () => {
  it("defaults to 7", () => {
    expect(DEFAULT_PAST_DUE_GRACE_DAYS).toBe(7);
    expect(PAST_DUE_GRACE_DAYS).toBe(7);
    expect(parseGraceDays(undefined)).toBe(7);
    expect(parseGraceDays(null)).toBe(7);
    expect(parseGraceDays("")).toBe(7);
  });

  it("accepts whole numbers from 0 to 365", () => {
    expect(parseGraceDays("3")).toBe(3);
    expect(parseGraceDays(" 14 ")).toBe(14);
    expect(parseGraceDays("0")).toBe(0);
    expect(parseGraceDays("365")).toBe(365);
  });

  it("falls back to 7 for anything invalid", () => {
    for (const raw of ["abc", "-1", "1.5", "1e3", "366", "9999", "0x10", "7 days", "NaN", "Infinity", "  "]) {
      expect(parseGraceDays(raw), raw).toBe(7);
    }
  });
});

describe("blocksCheckout", () => {
  it("blocks active, trialing, past_due, unpaid, paused and incomplete", () => {
    expect([...CHECKOUT_BLOCKING_STATUSES]).toEqual(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]);
    for (const status of CHECKOUT_BLOCKING_STATUSES) expect(blocksCheckout(status), status).toBe(true);
  });

  it("allows canceled, incomplete_expired, unknown and missing statuses", () => {
    for (const status of ["canceled", "incomplete_expired", "weird", "", null, undefined]) expect(blocksCheckout(status), String(status)).toBe(false);
  });
});

describe("nextPastDueSince", () => {
  it("sets now on first sight, keeps an existing start, and clears it for any other status", () => {
    expect(nextPastDueSince("past_due", null, NOW)).toEqual(NOW);
    expect(nextPastDueSince("past_due", daysAgo(3), NOW)).toEqual(daysAgo(3));
    for (const status of ["active", "trialing", "unpaid", "paused", "canceled", "incomplete", null]) {
      expect(nextPastDueSince(status, daysAgo(3), NOW), String(status)).toBeNull();
    }
  });
});

describe("storedPlanEntitled", () => {
  it("trusts a plan that was never synced from Stripe, and otherwise follows isEntitled", () => {
    expect(storedPlanEntitled({ subscriptionStatus: null }, NOW)).toBe(true);
    expect(storedPlanEntitled({}, NOW)).toBe(true);
    expect(storedPlanEntitled({ subscriptionStatus: "active" }, NOW)).toBe(true);
    expect(storedPlanEntitled({ subscriptionStatus: "past_due", pastDueSince: daysAgo(6) }, NOW)).toBe(true);
    expect(storedPlanEntitled({ subscriptionStatus: "past_due", pastDueSince: daysAgo(8) }, NOW)).toBe(false);
    for (const status of ["unpaid", "paused", "incomplete", "incomplete_expired", "canceled", "weird"]) {
      expect(storedPlanEntitled({ subscriptionStatus: status }, NOW), status).toBe(false);
    }
  });
});

describe("checkout copy by status", () => {
  it("maps each blocking status to its own notice", () => {
    expect(checkoutNotice({ code: "already_subscribed", status: "active" })).toBe(ACTIVE_NOTICE);
    expect(checkoutNotice({ code: "already_subscribed", status: "trialing" })).toBe(ACTIVE_NOTICE);
    expect(checkoutNotice({ code: "already_subscribed", status: "past_due" })).toBe(PAST_DUE_NOTICE);
    expect(checkoutNotice({ code: "already_subscribed", status: "unpaid" })).toBe(UNPAID_NOTICE);
    expect(checkoutNotice({ code: "already_subscribed", status: "paused" })).toBe(PAUSED_NOTICE);
    expect(checkoutNotice({ code: "already_subscribed", status: "incomplete" })).toBe(INCOMPLETE_NOTICE);
  });

  it("past_due and unpaid ask for a new card in Manage billing", () => {
    for (const n of [PAST_DUE_NOTICE, UNPAID_NOTICE]) {
      expect(n.body).toMatch(/Update your card in Manage billing/);
      expect(n.button).toBe("Update payment method");
    }
  });

  it("paused asks for a payment method to resume, and incomplete says the first payment is pending or needs action", () => {
    expect(PAUSED_NOTICE.body).toMatch(/Add one in Manage billing to resume/);
    expect(PAUSED_NOTICE.button).toBe("Add payment method");
    expect(INCOMPLETE_NOTICE.body).toMatch(/first payment is still pending or needs action/);
  });

  it("none of the copy uses an em dash and unpaid, paused and incomplete never read as active", () => {
    for (const n of [ACTIVE_NOTICE, PAST_DUE_NOTICE, UNPAID_NOTICE, PAUSED_NOTICE, INCOMPLETE_NOTICE]) {
      expect(`${n.headline} ${n.body} ${n.button}`).not.toMatch(/—|–/);
    }
    for (const n of [UNPAID_NOTICE, PAUSED_NOTICE, INCOMPLETE_NOTICE]) expect(n).not.toBe(ACTIVE_NOTICE);
  });
});

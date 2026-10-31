import { describe, expect, it } from "vitest";
import {
  billedMinutes, capFor, nextAnchorUnix, periodFor, premiumVoiceCap, secondsUntilCap, settleCall,
  MAX_CALL_SECONDS, type CallEndReasonId,
} from "@/lib/usagePlan";

const T = new Date("2026-10-15T12:00:00Z");
const after = (sec: number) => new Date(T.getTime() + sec * 1000);
const settle = (sec: number, reason: CallEndReasonId, remainingMinutes = 100, connected = true) =>
  settleCall({ connectedAt: connected ? T : null, endedAt: after(sec), reason, remainingMinutes });

describe("caps", () => {
  it("Free 20, Pro 200, Team 300 per seat with a floor of 3 seats", () => {
    expect(capFor("free")).toBe(20);
    expect(capFor("pro")).toBe(200);
    expect(capFor("team", 3)).toBe(900);
    expect(capFor("team", 4)).toBe(1200);
    expect(capFor("team", 1)).toBe(900);
  });

  it("premium voice is capped at 60% of plan minutes", () => {
    expect(premiumVoiceCap(200)).toBe(120);
    expect(premiumVoiceCap(900)).toBe(540);
    expect(premiumVoiceCap(20)).toBe(12);
  });
});

describe("rounding (rule 5)", () => {
  it("every started minute counts", () => {
    expect(billedMinutes(0)).toBe(0);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60)).toBe(1);
    expect(billedMinutes(61)).toBe(2);
    expect(billedMinutes(190)).toBe(4);
  });
});

describe("settleCall", () => {
  it("1: a call that never connects bills nothing", () => {
    const r = settle(0, "failed_connect", 100, false);
    expect(r).toMatchObject({ outcome: "failed_connect", netMinutes: 0, grossMinutes: 0 });
    // Even a hang-up before connect is a call that never connected.
    expect(settle(8, "user_hangup", 100, false).outcome).toBe("failed_connect");
  });

  it("2, 3: a network drop at 12s or exactly 30s is billed then credited back", () => {
    for (const sec of [12, 30]) {
      expect(settle(sec, "network_drop")).toMatchObject({ outcome: "dropped_credited", grossMinutes: 1, creditMinutes: 1, netMinutes: 0 });
    }
  });

  it("4: a network drop at 31s is billed", () => {
    expect(settle(31, "network_drop")).toMatchObject({ outcome: "billed", netMinutes: 1, creditMinutes: 0 });
  });

  it("5, 24: a user hang-up at 10s or 25s is still billed one minute", () => {
    for (const sec of [10, 25]) expect(settle(sec, "user_hangup")).toMatchObject({ outcome: "billed", netMinutes: 1, creditMinutes: 0 });
  });

  it("6, 7, 8: 60s is 1 minute, 61s is 2, 3m10s is 4", () => {
    expect(settle(60, "user_hangup").netMinutes).toBe(1);
    expect(settle(61, "user_hangup").netMinutes).toBe(2);
    expect(settle(190, "user_hangup").netMinutes).toBe(4);
  });

  it("25: a server error at 25s is credited", () => {
    expect(settle(25, "server_error")).toMatchObject({ outcome: "dropped_credited", netMinutes: 0 });
  });

  it("19: a provider error at 45s is outside the window and billed", () => {
    expect(settle(45, "provider_error")).toMatchObject({ outcome: "billed", netMinutes: 1 });
  });

  it("a heartbeat timeout or cap stop is not a failure to credit", () => {
    expect(settle(20, "heartbeat_timeout").outcome).toBe("billed");
  });

  it("13: never bills more than what was left, and records cap_reached", () => {
    const r = settle(300, "user_hangup", 2);
    expect(r).toMatchObject({ netMinutes: 2, billableSeconds: 120, endReason: "cap_reached" });
  });

  it("clamps at the 24 hour maximum", () => {
    const r = settle(MAX_CALL_SECONDS + 5000, "user_hangup", 100_000);
    expect(r).toMatchObject({ billableSeconds: MAX_CALL_SECONDS, endReason: "max_duration" });
  });

  it("never bills a negative duration", () => {
    expect(settleCall({ connectedAt: after(10), endedAt: T, reason: "user_hangup", remainingMinutes: 5 }).netMinutes).toBe(0);
  });
});

describe("secondsUntilCap", () => {
  it("counts down to zero and no further", () => {
    expect(secondsUntilCap(2, 0)).toBe(120);
    expect(secondsUntilCap(2, 119)).toBe(1);
    expect(secondsUntilCap(2, 400)).toBe(0);
  });
});

describe("monthly period (rule 13)", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it("21: anchored to signup day, so a Mar 10 signup resets on Apr 10", () => {
    const anchor = new Date("2026-03-10T09:30:00Z");
    expect(iso(periodFor(anchor, new Date("2026-04-09T23:00:00Z")).start)).toBe("2026-03-10");
    const p = periodFor(anchor, new Date("2026-04-10T09:30:00Z"));
    expect([iso(p.start), iso(p.end)]).toEqual(["2026-04-10", "2026-05-10"]);
  });

  it("22: a Jan 31 signup resets Feb 28, then Mar 31 (and Feb 29 in a leap year)", () => {
    const anchor = new Date("2026-01-31T08:00:00Z");
    expect(iso(periodFor(anchor, new Date("2026-02-27T00:00:00Z")).start)).toBe("2026-01-31");
    expect(iso(periodFor(anchor, new Date("2026-02-28T08:00:00Z")).start)).toBe("2026-02-28");
    expect(iso(periodFor(anchor, new Date("2026-03-30T00:00:00Z")).start)).toBe("2026-02-28");
    expect(iso(periodFor(anchor, new Date("2026-03-31T08:00:00Z")).start)).toBe("2026-03-31");
    const leap = new Date("2028-01-31T08:00:00Z");
    expect(iso(periodFor(leap, new Date("2028-02-29T08:00:00Z")).start)).toBe("2028-02-29");
  });

  it("crosses a year boundary and a long gap without drifting", () => {
    const anchor = new Date("2025-11-30T00:00:00Z");
    expect(iso(periodFor(anchor, new Date("2026-02-28T00:00:00Z")).start)).toBe("2026-02-28");
    expect(iso(periodFor(anchor, new Date("2027-01-05T00:00:00Z")).start)).toBe("2026-12-30");
  });

  it("before the anchor, the first period starts at the anchor", () => {
    const anchor = new Date("2026-05-10T00:00:00Z");
    expect(iso(periodFor(anchor, new Date("2026-05-01T00:00:00Z")).start)).toBe("2026-05-10");
  });
});

describe("Stripe billing_cycle_anchor", () => {
  const anchor = new Date("2026-03-10T09:30:00Z");

  it("is the next occurrence of the anchor day, in unix seconds", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    expect(nextAnchorUnix(anchor, now)).toBe(Math.floor(new Date("2026-11-10T09:30:00Z").getTime() / 1000));
  });

  it("is omitted on the anchor day itself, where Stripe would anchor to now anyway", () => {
    expect(nextAnchorUnix(anchor, new Date("2026-10-10T15:00:00Z"))).toBeNull();
  });

  it("lands on the last day of a short month for a 31st anchor", () => {
    const a31 = new Date("2026-01-31T08:00:00Z");
    expect(nextAnchorUnix(a31, new Date("2026-02-10T00:00:00Z"))).toBe(Math.floor(new Date("2026-02-28T08:00:00Z").getTime() / 1000));
  });
});

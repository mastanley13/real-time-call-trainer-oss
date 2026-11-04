import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { chooseEngine, resolveAllowance } from "@/lib/usage";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-03T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

beforeEach(() => {
  mocks.fake = createFakePrisma();
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
});
afterEach(() => vi.unstubAllEnvs());

const seedPro = (subscriptionStatus: string | null, pastDueSince: Date | null) => {
  mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", planTier: "pro", subscriptionStatus, pastDueSince, usageAnchorAt: daysAgo(40) });
};

describe("paid plan resolution follows the entitlement helper", () => {
  it("keeps Pro for active, trialing and past_due on day 6", async () => {
    for (const [status, since] of [["active", null], ["trialing", null], ["past_due", daysAgo(6)]] as const) {
      mocks.fake = createFakePrisma();
      seedPro(status, since);
      expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan, status).toBe("pro");
    }
  });

  it("drops to Free for past_due on day 8 and for every non-entitled status", async () => {
    for (const [status, since] of [["past_due", daysAgo(8)], ["unpaid", null], ["paused", null], ["incomplete", null], ["incomplete_expired", null], ["canceled", null], ["weird", null]] as const) {
      mocks.fake = createFakePrisma();
      seedPro(status, since);
      expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan, status).toBe("free");
    }
  });

  it("persists a start for a past_due user with none, so the grace window can run out later", async () => {
    seedPro("past_due", null);
    const row = () => mocks.fake.rows("user").find((u) => u.id === "u-1")!;
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan).toBe("pro");
    expect((row().pastDueSince as Date).getTime()).toBe(NOW.getTime());
    // Later reads keep the first start: day 6 still Pro, day 8 Free, with no webhook in between.
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", new Date(NOW.getTime() + 6 * DAY)))?.plan).toBe("pro");
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", new Date(NOW.getTime() + 8 * DAY)))?.plan).toBe("free");
    expect((row().pastDueSince as Date).getTime()).toBe(NOW.getTime());
  });

  it("persists a start for a past_due organization with none, and the pool ends after grace", async () => {
    mocks.fake.seed("organization", { id: "org-1", code: "123", planTier: "team", seatCount: 3, premiumVoice: true, subscriptionStatus: "past_due", pastDueSince: null, createdAt: daysAgo(90) });
    mocks.fake.seed("user", { id: "m-1", email: "m-1@example.test", organizationId: "org-1", usageAnchorAt: daysAgo(40) });
    const org = () => mocks.fake.rows("organization").find((o) => o.id === "org-1")!;
    expect((await resolveAllowance(mocks.fake.db as never, "m-1", NOW))).toMatchObject({ pooled: true, plan: "team", premiumVoice: true });
    expect((org().pastDueSince as Date).getTime()).toBe(NOW.getTime());
    expect((await resolveAllowance(mocks.fake.db as never, "m-1", new Date(NOW.getTime() + 8 * DAY)))).toMatchObject({ pooled: false, plan: "free", premiumVoice: false });
  });

  it("Premium voice goes off with paid access when grace runs out, even though the stored flag is still true", async () => {
    mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", planTier: "pro", premiumVoice: true, subscriptionStatus: "past_due", pastDueSince: daysAgo(6), usageAnchorAt: daysAgo(40) });
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))).toMatchObject({ plan: "pro", premiumVoice: true });
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", new Date(NOW.getTime() + 2 * DAY)))).toMatchObject({ plan: "free", premiumVoice: false });
    expect(mocks.fake.rows("user")[0].premiumVoice).toBe(true);
  });

  it("chooseEngine gives no Premium engine once the plan has lapsed", async () => {
    mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", planTier: "pro", premiumVoice: true, subscriptionStatus: "unpaid", usageAnchorAt: daysAgo(40) });
    const r = await resolveAllowance(mocks.fake.db as never, "u-1", NOW);
    expect(chooseEngine(r!, 10)).toEqual({ engine: "standard", premiumMinutes: 0 });
  });

  it("a comped account (no Stripe subscription, no status) keeps its stored plan", async () => {
    seedPro(null, null);
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan).toBe("pro");
  });

  it("a linked account with a missing status is Free, for a user and for a Team pool", async () => {
    mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", planTier: "pro", stripeSubscriptionId: "sub_test_1", subscriptionStatus: null, usageAnchorAt: daysAgo(40) });
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan).toBe("free");
    mocks.fake.seed("organization", { id: "org-1", code: "123", planTier: "team", seatCount: 3, stripeSubscriptionId: "sub_test_team", subscriptionStatus: null, createdAt: daysAgo(90) });
    mocks.fake.seed("user", { id: "m-1", email: "m-1@example.test", organizationId: "org-1", usageAnchorAt: daysAgo(40) });
    expect(await resolveAllowance(mocks.fake.db as never, "m-1", NOW)).toMatchObject({ pooled: false, plan: "free" });
  });

  it("a stale stamp never overwrites a webhook that moved the status on, and the next past_due episode gets a fresh start", async () => {
    seedPro("past_due", null);
    const row = () => mocks.fake.rows("user").find((u) => u.id === "u-1")!;
    // The webhook commits active (clearing pastDueSince) between this request's read and its write.
    mocks.fake.interleave("user", "updateMany", async () => {
      await mocks.fake.db.user.update({ where: { id: "u-1" }, data: { subscriptionStatus: "active", pastDueSince: null } });
    });
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan).toBe("pro");
    expect(row()).toMatchObject({ subscriptionStatus: "active", pastDueSince: null });
    // A later past_due episode is stamped when it is first seen, not with the old time.
    const later = new Date(NOW.getTime() + 30 * DAY);
    row().subscriptionStatus = "past_due";
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", later))?.plan).toBe("pro");
    expect((row().pastDueSince as Date).getTime()).toBe(later.getTime());
  });

  it("the stamp is a conditional write and keeps an existing start", async () => {
    seedPro("past_due", daysAgo(3));
    await resolveAllowance(mocks.fake.db as never, "u-1", NOW);
    expect((mocks.fake.rows("user")[0].pastDueSince as Date).getTime()).toBe(daysAgo(3).getTime());
  });
});

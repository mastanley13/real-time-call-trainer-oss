import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { resolveAllowance } from "@/lib/usage";

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

  it("an account never synced from Stripe keeps its stored plan", async () => {
    seedPro(null, null);
    expect((await resolveAllowance(mocks.fake.db as never, "u-1", NOW))?.plan).toBe("pro");
  });
});

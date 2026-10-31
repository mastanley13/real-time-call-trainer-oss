import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const beginCall = vi.fn();
vi.mock("@/lib/usage", () => ({ beginCall: (...a: unknown[]) => beginCall(...a), endCall: vi.fn(async () => null) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: "u1" }) }));

import { GET as elToken } from "@/app/api/elevenlabs/token/route";
import { meteringEnabled } from "@/lib/serverConfig";

function req() {
  return new NextRequest("http://localhost/api/elevenlabs/token?scenarioId=s1");
}

beforeEach(() => {
  beginCall.mockReset();
  vi.stubEnv("DATABASE_URL", "postgresql://x:x@localhost:5432/x");
  vi.stubEnv("ELEVENLABS_API_KEY", "k");
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_main");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "tok" })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("meteringEnabled", () => {
  const db = { DATABASE_URL: "postgresql://x:x@localhost:5432/x" };
  it("is on with a database and a Stripe key (billing on)", () => {
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
  });
  it("stays on when the key is refused, so a bad paid setup fails closed", () => {
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(true);
  });
  it("is off without a Stripe key even with a database (billing off)", () => {
    expect(meteringEnabled({ ...db })).toBe(false);
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "  " })).toBe(false);
  });
  it("is off in demo mode and without a database", () => {
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "sk_test_abc", DEMO_MODE: "true" })).toBe(false);
    expect(meteringEnabled({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(false);
  });
});

describe("voice mint and billing", () => {
  it("billing off: mints with no reservation, no cap, no callId", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    beginCall.mockResolvedValue({ ok: false, error: "cap_reached" });
    const res = await elToken(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "tok" });
    expect(beginCall).not.toHaveBeenCalled();
  });

  it("billing on: reserves through beginCall and returns the callId", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    beginCall.mockResolvedValue({ ok: true, callId: "c1", maxSeconds: 300, engine: "premium" });
    const res = await elToken(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "tok", callId: "c1", maxSeconds: 300 });
    expect(beginCall).toHaveBeenCalledTimes(1);
  });

  it("billing on: a reached cap blocks the mint", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    beginCall.mockResolvedValue({ ok: false, error: "cap_reached" });
    const res = await elToken(req());
    expect(res.status).not.toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});

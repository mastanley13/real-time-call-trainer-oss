import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const beginCall = vi.fn();
vi.mock("@/lib/usage", () => ({ beginCall: (...a: unknown[]) => beginCall(...a), endCall: vi.fn(async () => null) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: "u1" }) }));
// The spend kill switch reads its durable row with a database configured; nothing is tripped here.
vi.mock("@/lib/db", () => ({ prisma: { spendState: { findUnique: async () => null } } }));

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
  it("is off by default with a database and no Stripe key, so self-hosters stay uncapped", () => {
    expect(meteringEnabled({ ...db })).toBe(false);
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "  " })).toBe(false);
    expect(meteringEnabled({ ...db, USAGE_CAPS: "off" })).toBe(false);
    expect(meteringEnabled({ ...db, USAGE_CAPS: "" })).toBe(false);
  });
  it("USAGE_CAPS=on turns it on with no Stripe key", () => {
    expect(meteringEnabled({ ...db, USAGE_CAPS: "on" })).toBe(true);
    expect(meteringEnabled({ ...db, USAGE_CAPS: "on", STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
  });
  it("is off in demo mode and without a database, even with USAGE_CAPS=on or Stripe set", () => {
    expect(meteringEnabled({ ...db, STRIPE_SECRET_KEY: "sk_test_abc", DEMO_MODE: "true" })).toBe(false);
    expect(meteringEnabled({ ...db, USAGE_CAPS: "on", DEMO_MODE: "true" })).toBe(false);
    expect(meteringEnabled({ USAGE_CAPS: "on" })).toBe(false);
    expect(meteringEnabled({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(false);
    expect(meteringEnabled({})).toBe(false);
  });
});

describe("voice mint and billing", () => {
  it("USAGE_CAPS off and no Stripe key: mints with no reservation, no cap, no callId", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("USAGE_CAPS", "");
    beginCall.mockResolvedValue({ ok: false, error: "cap_reached" });
    const res = await elToken(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "tok" });
    expect(beginCall).not.toHaveBeenCalled();
  });

  it("USAGE_CAPS=on, no Stripe key: still reserves through beginCall and returns the callId", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("USAGE_CAPS", "on");
    beginCall.mockResolvedValue({ ok: true, callId: "c1", maxSeconds: 600, engine: "premium" });
    const res = await elToken(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "tok", callId: "c1" });
    expect(beginCall).toHaveBeenCalledTimes(1);
  });

  it("USAGE_CAPS=on, no Stripe key: a reached cap blocks the mint", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("USAGE_CAPS", "on");
    beginCall.mockResolvedValue({ ok: false, error: "cap_reached" });
    const res = await elToken(req());
    expect(res.status).toBe(402);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("demo mode: mints with no reservation, no cap, no callId", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    beginCall.mockResolvedValue({ ok: false, error: "cap_reached" });
    const res = await elToken(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "tok" });
    expect(beginCall).not.toHaveBeenCalled();
  });

  it("a usage lookup error refuses the mint (fail closed) without calling the provider", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("USAGE_CAPS", "on");
    beginCall.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await elToken(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "usage_unavailable", message: "Voice is unavailable right now. Text practice still works." });
    expect(fetch).not.toHaveBeenCalled();
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

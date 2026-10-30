import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import {
  REALTIME_MINUTES_PER_CALL, dailyRealtimeMinutesCap, paidFeaturesAvailable, paidFeaturesEnabled, paidFeaturesGuard,
  realtimeMinutesReserved, releaseRealtimeCall, reserveRealtimeCall, resetSpendGuard,
} from "@/lib/spendGuard";
import { POST as sessionPOST } from "@/app/api/realtime/session/route";
import { POST as sdpPOST } from "@/app/api/realtime/sdp/route";
import { POST as coachPOST } from "@/app/api/coach/turn/route";
import { POST as evaluatePOST } from "@/app/api/evaluate-call/route";
import { POST as personaPOST } from "@/app/api/persona/generate/route";
import { POST as simulatePOST } from "@/app/api/simulate/turn/route";

const scenario = BUILT_IN_SCENARIOS[0];
let ip = 0;
const req = (path: string, body: unknown = {}) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ip % 250}` },
  body: JSON.stringify(body),
});

const DAY = Date.UTC(2026, 9, 30, 12);

beforeEach(() => {
  resetSpendGuard();
  // Demo mode signs every request in, so the guard runs right after a real requireAuth.
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("PAID_FEATURES_ENABLED", "");
  vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("spend guard settings", () => {
  it("is on unless PAID_FEATURES_ENABLED is false", () => {
    expect(paidFeaturesEnabled()).toBe(true);
    for (const v of ["true", "1", "yes"]) {
      vi.stubEnv("PAID_FEATURES_ENABLED", v);
      expect(paidFeaturesEnabled()).toBe(true);
    }
    for (const v of ["false", "FALSE", " false "]) {
      vi.stubEnv("PAID_FEATURES_ENABLED", v);
      expect(paidFeaturesEnabled()).toBe(false);
    }
  });

  it.each([["", null], ["abc", null], ["-5", null], ["1.5", null], ["0", 0], [" 600 ", 600]])("reads DAILY_REALTIME_MINUTES_CAP=%j as %j", (raw, want) => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", raw as string);
    expect(dailyRealtimeMinutesCap()).toBe(want);
  });
});

describe("daily voice-minute cap", () => {
  it("never limits without a cap", () => {
    for (let i = 0; i < 50; i++) expect(reserveRealtimeCall(DAY)).toBe(true);
    expect(paidFeaturesAvailable(DAY)).toBe(true);
  });

  it("refuses a call that would go over and turns paid routes off once reached", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL * 2 + 5));
    expect(reserveRealtimeCall(DAY)).toBe(true);
    expect(reserveRealtimeCall(DAY)).toBe(true);
    // 25-minute cap with 20 reserved: a third 10-minute call would go over, but the cap is not reached yet.
    expect(reserveRealtimeCall(DAY)).toBe(false);
    expect(paidFeaturesAvailable(DAY)).toBe(true);

    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL * 2));
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    expect(paidFeaturesGuard(DAY)?.status).toBe(503);
  });

  it("gives a reservation back when the call never started", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    expect(reserveRealtimeCall(DAY)).toBe(true);
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    releaseRealtimeCall(DAY);
    expect(realtimeMinutesReserved(DAY)).toBe(0);
    releaseRealtimeCall(DAY);
    expect(realtimeMinutesReserved(DAY)).toBe(0);
  });

  it("starts over at midnight UTC", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    expect(reserveRealtimeCall(DAY)).toBe(true);
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    const nextDay = DAY + 12 * 3_600_000;
    expect(paidFeaturesAvailable(nextDay)).toBe(true);
    expect(reserveRealtimeCall(nextDay)).toBe(true);
  });

  it("reserves nothing while the switch is off", () => {
    vi.stubEnv("PAID_FEATURES_ENABLED", "false");
    expect(reserveRealtimeCall(DAY)).toBe(false);
    expect(realtimeMinutesReserved(DAY)).toBe(0);
  });
});

describe("paid routes", () => {
  const routes = [
    ["/api/realtime/session", sessionPOST],
    ["/api/realtime/sdp", sdpPOST],
    ["/api/coach/turn", coachPOST],
    ["/api/evaluate-call", evaluatePOST],
    ["/api/persona/generate", personaPOST],
  ] as const;

  it.each(routes)("%s answers 503 paid_features_off with the switch off, before any provider call", async (path, POST) => {
    vi.stubEnv("PAID_FEATURES_ENABLED", "false");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(path));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("paid_features_off");
    expect(body.message).toMatch(/scripted caller/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(routes)("%s answers 503 daily_cap_reached once the cap is used up", async (path, POST) => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", "0");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const res = await POST(req(path));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("daily_cap_reached");
    expect(body.message).toMatch(/midnight UTC/);
  });

  it("realtime/session reserves minutes when it mints a secret and stops at the cap", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: "ek_test123456", expires_at: 1_900_000_000 })));
    expect((await sessionPOST(req("/api/realtime/session", { scenario }))).status).toBe(200);
    expect(realtimeMinutesReserved()).toBe(REALTIME_MINUTES_PER_CALL);
    const second = await sessionPOST(req("/api/realtime/session", { scenario }));
    expect(second.status).toBe(503);
    expect((await second.json()).error).toBe("daily_cap_reached");
  });

  it.each([
    ["an upstream error", async () => new Response("{}", { status: 500 })],
    ["a response with no secret", async () => Response.json({})],
    ["a network failure", async () => { throw new Error("offline"); }],
  ])("realtime/session gives the minutes back after %s", async (_label, impl) => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    vi.stubGlobal("fetch", vi.fn(impl));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await sessionPOST(req("/api/realtime/session", { scenario }))).status).toBe(502);
    expect(realtimeMinutesReserved()).toBe(0);
  });
});

describe("text caller fallback", () => {
  const history = [{ role: "user", text: "Hi, this is Sam calling about your quote." }];

  it("uses the LLM while paid features are on", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "Oh hi, what's this about?" }, finish_reason: "stop" }] })));
    const body = await (await simulatePOST(req("/api/simulate/turn", { scenario, history }))).json();
    expect(body.source).toBe("llm");
  });

  it.each([["PAID_FEATURES_ENABLED", "false"], ["DAILY_REALTIME_MINUTES_CAP", "0"]])("falls back to the scripted caller with %s=%s", async (name, value) => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv(name, value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await simulatePOST(req("/api/simulate/turn", { scenario, history }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("scripted");
    expect(body.reply).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

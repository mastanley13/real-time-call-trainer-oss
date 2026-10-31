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
import { GET as elevenLabsGET } from "@/app/api/elevenlabs/token/route";
import { POST as llmCheckPOST } from "@/app/api/llm/check/route";

const scenario = BUILT_IN_SCENARIOS[0];
let ip = 0;
const req = (path: string, body: unknown = {}) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ip % 250}` },
  body: JSON.stringify(body),
});
const getReq = (path: string) => new NextRequest(`http://localhost${path}`, { headers: { "x-forwarded-for": `198.51.100.${++ip % 250}` } });

const DAY = Date.UTC(2026, 9, 30, 12);
const MIDNIGHT = Date.UTC(2026, 9, 31);
const SDP_OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";
const SDP_ANSWER = "v=0\r\no=- 3 4 IN IP4 192.0.2.1\r\ns=-\r\n";

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
    for (let i = 0; i < 50; i++) expect(reserveRealtimeCall(DAY)).not.toBeNull();
    expect(paidFeaturesAvailable(DAY)).toBe(true);
  });

  it("refuses a call that would go over and turns paid routes off once reached", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL * 2 + 5));
    expect(reserveRealtimeCall(DAY)).not.toBeNull();
    expect(reserveRealtimeCall(DAY)).not.toBeNull();
    // 25-minute cap with 20 reserved: a third 10-minute call would go over, but the cap is not reached yet.
    expect(reserveRealtimeCall(DAY)).toBeNull();
    expect(paidFeaturesAvailable(DAY)).toBe(true);

    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL * 2));
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    expect(paidFeaturesGuard(DAY)?.status).toBe(503);
  });

  it("gives a reservation back when the call never started", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    const reservation = reserveRealtimeCall(DAY)!;
    expect(reservation).not.toBeNull();
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    releaseRealtimeCall(reservation, DAY);
    expect(realtimeMinutesReserved(DAY)).toBe(0);
  });

  it("releases a reservation only once", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL * 2));
    const first = reserveRealtimeCall(DAY)!;
    expect(reserveRealtimeCall(DAY)).not.toBeNull();
    releaseRealtimeCall(first, DAY);
    releaseRealtimeCall(first, DAY);
    // The second call's minutes stay reserved.
    expect(realtimeMinutesReserved(DAY)).toBe(REALTIME_MINUTES_PER_CALL);
  });

  it("releases against the day the minutes were reserved, not the day the mint failed", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    const beforeMidnight = reserveRealtimeCall(MIDNIGHT - 1_000)!;
    expect(beforeMidnight.day).toBe("2026-10-30");
    const afterMidnight = reserveRealtimeCall(MIDNIGHT + 1_000)!;
    expect(afterMidnight.day).toBe("2026-10-31");
    // The first mint fails after midnight: the new day's reservation stays, so the cap still holds.
    releaseRealtimeCall(beforeMidnight, MIDNIGHT + 2_000);
    expect(realtimeMinutesReserved(MIDNIGHT + 2_000)).toBe(REALTIME_MINUTES_PER_CALL);
    expect(reserveRealtimeCall(MIDNIGHT + 3_000)).toBeNull();
    // Releasing the new day's own reservation still works.
    releaseRealtimeCall(afterMidnight, MIDNIGHT + 4_000);
    expect(realtimeMinutesReserved(MIDNIGHT + 4_000)).toBe(0);
  });

  it("starts over at midnight UTC", () => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    expect(reserveRealtimeCall(DAY)).not.toBeNull();
    expect(paidFeaturesAvailable(DAY)).toBe(false);
    const nextDay = DAY + 12 * 3_600_000;
    expect(paidFeaturesAvailable(nextDay)).toBe(true);
    expect(reserveRealtimeCall(nextDay)).not.toBeNull();
  });

  it("reserves nothing while the switch is off", () => {
    vi.stubEnv("PAID_FEATURES_ENABLED", "false");
    expect(reserveRealtimeCall(DAY)).toBeNull();
    expect(realtimeMinutesReserved(DAY)).toBe(0);
  });
});

describe("paid routes", () => {
  const post = (path: string, POST: (r: NextRequest) => Promise<Response>) => [path, () => POST(req(path))] as const;
  // Every route that can reach a paid provider. PATCH /api/transcripts/[id] needs a mocked database, so it is in regrade.test.ts.
  const admits = [
    post("/api/realtime/session", sessionPOST),
    post("/api/coach/turn", coachPOST),
    post("/api/evaluate-call", evaluatePOST),
    post("/api/persona/generate", personaPOST),
    post("/api/llm/check", llmCheckPOST),
    ["/api/elevenlabs/token", () => elevenLabsGET(getReq("/api/elevenlabs/token"))],
  ] as const;
  const routes = [...admits, post("/api/realtime/sdp", sdpPOST)];

  const configureProviders = () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-test");
  };

  it.each(routes)("%s answers 503 paid_features_off with the switch off, before any provider call", async (_path, call) => {
    vi.stubEnv("PAID_FEATURES_ENABLED", "false");
    configureProviders();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.error).toBe("paid_features_off");
    expect(body.message).toMatch(/scripted caller/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(admits)("%s answers 503 daily_cap_reached once the cap is used up", async (_path, call) => {
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", "0");
    configureProviders();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("daily_cap_reached");
    expect(body.message).toMatch(/midnight UTC/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects a voice call that reserved the day's last minutes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/realtime/client_secrets")
        ? Response.json({ value: "ek_test123456", expires_at: 1_900_000_000 })
        : new Response(SDP_ANSWER, { headers: { "content-type": "application/sdp" } }));
    vi.stubGlobal("fetch", fetchMock);

    const minted = await sessionPOST(req("/api/realtime/session", { scenario }));
    expect(minted.status).toBe(200);
    const { clientSecret } = await minted.json();
    expect(paidFeaturesAvailable()).toBe(false);

    const answer = await sdpPOST(req("/api/realtime/sdp", { clientSecret, sdp: SDP_OFFER }));
    expect(answer.status).toBe(200);
    expect((await answer.json()).sdp).toBe(SDP_ANSWER);
    expect(fetchMock).toHaveBeenLastCalledWith("https://api.openai.com/v1/realtime/calls", expect.objectContaining({ body: SDP_OFFER }));
    expect(realtimeMinutesReserved()).toBe(REALTIME_MINUTES_PER_CALL);

    // A new call is still refused at the mint.
    const next = await sessionPOST(req("/api/realtime/session", { scenario }));
    expect(next.status).toBe(503);
    expect((await next.json()).error).toBe("daily_cap_reached");
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

  it("realtime/session gives back only its own minutes when its mint fails after midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(MIDNIGHT - 1_000);
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    vi.spyOn(console, "error").mockImplementation(() => {});
    let other = null as ReturnType<typeof reserveRealtimeCall>;
    vi.stubGlobal("fetch", vi.fn(async () => {
      // While OpenAI is slow, midnight passes and another call takes the new day's minutes.
      vi.setSystemTime(MIDNIGHT + 1_000);
      other = reserveRealtimeCall();
      return new Response("{}", { status: 500 });
    }));
    try {
      expect((await sessionPOST(req("/api/realtime/session", { scenario }))).status).toBe(502);
      expect(other).not.toBeNull();
      expect(realtimeMinutesReserved()).toBe(REALTIME_MINUTES_PER_CALL);
      expect(reserveRealtimeCall()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("elevenlabs/token reserves a voice call's minutes and stops at the cap", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    const fetchMock = vi.fn(async () => Response.json({ token: "el-conversation-token" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await elevenLabsGET(getReq("/api/elevenlabs/token"))).status).toBe(200);
    expect(realtimeMinutesReserved()).toBe(REALTIME_MINUTES_PER_CALL);
    const second = await elevenLabsGET(getReq("/api/elevenlabs/token"));
    expect(second.status).toBe(503);
    expect((await second.json()).error).toBe("daily_cap_reached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an upstream error", async () => new Response("{}", { status: 500 })],
    ["a response with no token", async () => Response.json({})],
    ["a network failure", async () => { throw new Error("offline"); }],
  ])("elevenlabs/token gives the minutes back after %s", async (_label, impl) => {
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    vi.stubGlobal("fetch", vi.fn(impl));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await elevenLabsGET(getReq("/api/elevenlabs/token"))).status).toBe(502);
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

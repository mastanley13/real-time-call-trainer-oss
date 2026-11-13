import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { POST as sessionPOST } from "@/app/api/realtime/session/route";
import { POST as sdpPOST } from "@/app/api/realtime/sdp/route";
import { signSessionToken } from "@/lib/auth";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const KEY = "test-secret-0123456789abcdef0123456789";
const scenario = BUILT_IN_SCENARIOS[0];

function hostedOff() {
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

function sessionReq(extra: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/realtime/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10", ...extra },
    body: JSON.stringify({ scenario }),
  });
}

function sdpReq(extra: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/realtime/sdp", {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify({ clientSecret: "ek_abc123456789", sdp: "v=0 offer sdp" }),
  });
}

beforeEach(() => {
  hostedOff();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hosted voice mint requires a live session", () => {
  it("POST /api/realtime/session is 401 without a cookie, and does not call OpenAI", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sessionPOST(sessionReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST /api/realtime/session is 401 Invalid or expired session when the JWT has expired", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const token = jwt.sign({ id: "u-rep", email: "rep@example.test" }, KEY, { expiresIn: -10 });
    const res = await sessionPOST(sessionReq({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a still-fresh session gets past auth (503 here because no OpenAI key is configured)", async () => {
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test", role: "trainee" });
    const res = await sessionPOST(sessionReq({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("realtime_not_configured");
  });
});

describe("hosted SDP relay requires a live session", () => {
  it("POST /api/realtime/sdp is 401 without a cookie, and does not call OpenAI", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sdpPOST(sdpReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST /api/realtime/sdp is 401 Invalid or expired session when the JWT has expired", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const token = jwt.sign({ id: "u-rep", email: "rep@example.test" }, KEY, { expiresIn: -10 });
    const res = await sdpPOST(sdpReq({ cookie: `authToken=${token}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

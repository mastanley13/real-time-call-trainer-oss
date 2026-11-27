import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { requireAuth, isDemoUser } from "@/lib/apiAuth";
import { DEMO_USER } from "@/lib/serverConfig";
import { signSessionToken } from "@/lib/auth";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as simulate } from "@/app/api/simulate/turn/route";
import { POST as coach } from "@/app/api/coach/turn/route";
import { POST as evaluate } from "@/app/api/evaluate-call/route";

// requireAuth is the hosted login skip. Most route tests mock it, so they would not notice if
// DEMO_MODE started skipping auth in production, or stopped skipping it for local demo runs.
// This file runs the real helper and three cost-bearing practice routes (text caller, live coach,
// grader) with no session mock.

const KEY = "test-secret-0123456789abcdef0123456789";
const scenario = BUILT_IN_SCENARIOS[0];
const transcript = [
  { role: "assistant" as const, text: scenario.aiPersona.openingLine },
  { role: "user" as const, text: "Hi, thanks for taking my call. Do you have a few minutes?" },
];

let n = 0;
const ip = () => `198.51.${Math.floor(++n / 250)}.${n % 250}`;

function req(path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip(),
    ...extra,
  };
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function hostedOff() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

function localDemo() {
  hostedOff();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEMO_MODE", "true");
}

beforeEach(() => hostedOff());
afterEach(() => vi.unstubAllEnvs());

function json(res: NextResponse | Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("requireAuth", () => {
  it("returns 401 Authentication required when demo mode is off and there is no cookie", async () => {
    const auth = requireAuth(req("/api/me"));
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
    expect(await json(auth as NextResponse)).toEqual({ error: "Authentication required" });
  });

  it("returns 401 Invalid or expired session for a garbage bearer token", async () => {
    const auth = requireAuth(req("/api/me", undefined, { authorization: "Bearer not-a-jwt" }));
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
    expect(await json(auth as NextResponse)).toEqual({ error: "Invalid or expired session" });
  });

  it("returns 401 for an expired session token", async () => {
    const token = jwt.sign({ id: "u-1", email: "rep@example.test" }, KEY, { expiresIn: -10 });
    const auth = requireAuth(req("/api/me", undefined, { authorization: `Bearer ${token}` }));
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
    expect(await json(auth as NextResponse)).toEqual({ error: "Invalid or expired session" });
  });

  it("accepts a valid session on the cookie or the Authorization header", () => {
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test", role: "trainee" });
    const fromHeader = requireAuth(req("/api/me", undefined, { authorization: `Bearer ${token}` }));
    const fromCookie = requireAuth(req("/api/me", undefined, { cookie: `authToken=${token}` }));
    if (fromHeader instanceof NextResponse) throw new Error("expected a session user from the bearer token");
    if (fromCookie instanceof NextResponse) throw new Error("expected a session user from the cookie");
    expect(fromHeader).toMatchObject({ id: "u-rep", email: "rep@example.test", role: "trainee" });
    expect(fromCookie).toMatchObject({ id: "u-rep", email: "rep@example.test" });
    expect(isDemoUser(fromHeader)).toBe(false);
  });

  it("fails closed in production: DEMO_MODE=true without ALLOW_PUBLIC_DEMO still requires a session", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const auth = requireAuth(req("/api/me"));
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
    expect(await json(auth as NextResponse)).toEqual({ error: "Authentication required" });
  });

  it("skips login for the demo user when DEMO_MODE is on in development", () => {
    localDemo();
    const auth = requireAuth(req("/api/me"));
    if (auth instanceof NextResponse) throw new Error("expected the demo user");
    expect(auth).toEqual(DEMO_USER);
    expect(isDemoUser(auth)).toBe(true);
  });

  it("skips login in production only with the explicit ALLOW_PUBLIC_DEMO opt-in", () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ALLOW_PUBLIC_DEMO", "true");
    const auth = requireAuth(req("/api/me"));
    expect(auth).toEqual(DEMO_USER);
  });

  it("does not accept other ALLOW_PUBLIC_DEMO values as the opt-in", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ALLOW_PUBLIC_DEMO", "1");
    const auth = requireAuth(req("/api/me"));
    expect(auth).toBeInstanceOf(NextResponse);
    expect((auth as NextResponse).status).toBe(401);
  });

  it("ignores a real session cookie while demo mode is on, so local runs cannot mix identities", () => {
    localDemo();
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test" });
    const auth = requireAuth(req("/api/me", undefined, { cookie: `authToken=${token}` }));
    expect(auth).toEqual(DEMO_USER);
  });
});

describe("cost-bearing practice routes stay gated", () => {
  const simBody = { scenario, history: transcript };
  const coachBody = { scenario, transcript, allowCue: true };
  const gradeBody = { scenario, transcript };

  it("text caller, live coach and grader all return 401 without a session when demo mode is off", async () => {
    const sim = await simulate(req("/api/simulate/turn", simBody));
    const cue = await coach(req("/api/coach/turn", coachBody));
    const grade = await evaluate(req("/api/evaluate-call", gradeBody));
    expect(sim.status).toBe(401);
    expect(cue.status).toBe(401);
    expect(grade.status).toBe(401);
    expect(await sim.json()).toEqual({ error: "Authentication required" });
    expect(await cue.json()).toEqual({ error: "Authentication required" });
    expect(await grade.json()).toEqual({ error: "Authentication required" });
  });

  it("a signed-in user can run a text turn without a model key (scripted caller)", async () => {
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test" });
    const res = await simulate(req("/api/simulate/turn", simBody, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    const body = await res.json() as { reply: string; source: string };
    expect(body.source).toBe("scripted");
    expect(body.reply.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("DEMO_MODE in development lets the text caller, coach and grader run as the demo user, with no keys", async () => {
    localDemo();
    const sim = await simulate(req("/api/simulate/turn", simBody));
    expect(sim.status).toBe(200);
    const simBodyOut = await sim.json() as { reply: string; source: string };
    expect(simBodyOut.source).toBe("scripted");
    expect(simBodyOut.reply.length).toBeGreaterThan(0);

    const cue = await coach(req("/api/coach/turn", coachBody));
    expect(cue.status).toBe(200);
    const cueBody = await cue.json() as { source: string; estimate: { overall: number } };
    expect(cueBody.source).toBe("heuristic");
    expect(cueBody.estimate.overall).toBeGreaterThanOrEqual(0);

    const grade = await evaluate(req("/api/evaluate-call", gradeBody));
    expect(grade.status).toBe(200);
    const gradeBodyOut = await grade.json() as { method: string; overallScore: number };
    expect(gradeBodyOut.method).toBe("heuristic");
    expect(gradeBodyOut.overallScore).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(gradeBodyOut)).not.toContain(KEY);
  });

  it("DEMO_MODE in production without the opt-in still 401s the text caller", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await simulate(req("/api/simulate/turn", simBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });
});

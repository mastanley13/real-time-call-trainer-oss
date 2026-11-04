import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    organization: { findUnique: vi.fn(), create: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma };
});
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { GET as start } from "@/app/api/auth/google/start/route";
import { GET as callback } from "@/app/api/auth/google/callback/route";
import { GET as sessionRoute } from "@/app/api/auth/session/route";
import { ACCESS_COOKIE, accessToken } from "@/lib/access";
import { verifyMfaChallengeToken, verifySessionToken } from "@/lib/auth";
import { authorizeUrl, checkIdTokenClaims, GOOGLE_FLOW_COOKIE, googleConfig, pkceChallenge, randomToken, safeNextPath, signFlowState, verifyFlowState } from "@/lib/googleAuth";
import { getCapabilities } from "@/lib/serverConfig";

const NOW = 1_800_000_000;
const good = {
  iss: "https://accounts.google.com", aud: "client-1", exp: NOW + 300, sub: "1234567890",
  email: "Rep@Example.test", email_verified: true, nonce: "nonce-abcdefghijklmnop", given_name: "Ravi", family_name: "Shah",
};
const expect_ = { clientId: "client-1", nonce: "nonce-abcdefghijklmnop", nowSec: NOW };

function useGoogleEnv() {
  vi.stubEnv("JWT_SECRET", "test-secret-0123456789abcdef0123456789");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-1");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret-1");
  vi.stubEnv("APP_URL", "https://calltrainer.example");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("TRAINER_ACCESS_CODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

beforeEach(() => {
  useGoogleEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkIdTokenClaims", () => {
  it("accepts a fresh, verified token for this client and lowercases the email", () => {
    expect(checkIdTokenClaims(good, expect_)).toEqual({ ok: true, profile: { sub: "1234567890", email: "rep@example.test", firstName: "Ravi", lastName: "Shah" } });
    expect(checkIdTokenClaims({ ...good, iss: "accounts.google.com", aud: ["other", "client-1"], email_verified: "true" }, expect_).ok).toBe(true);
  });
  it.each([
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "someone-else" }],
    ["expired", { exp: NOW }],
    ["nonce", { nonce: "replayed-nonce-0000000" }],
    ["email_unverified", { email_verified: false }],
    ["email_unverified", { email_verified: undefined }],
    ["malformed", { email: "not-an-email" }],
  ])("rejects %s", (reason, patch) => {
    expect(checkIdTokenClaims({ ...good, ...patch }, expect_)).toEqual({ ok: false, reason });
  });
  it("rejects junk", () => {
    expect(checkIdTokenClaims(null, expect_).ok).toBe(false);
    expect(checkIdTokenClaims("x", expect_).ok).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps same-site paths only", () => {
    expect(safeNextPath("/library?x=1")).toBe("/library?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "team", "", null, "/a\r\nSet-Cookie: x"]) {
      expect(safeNextPath(bad)).toBe("/trainer");
    }
  });
  it("rejects tabs, newlines, other control characters and backslashes that URL parsing would normalize away", () => {
    for (const bad of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\u0000/evil.example", "/\u007f/evil.example", "/x\\@evil.example", "/\t\\evil.example", decodeURIComponent("%2F%09%2Fevil.example")]) {
      expect(safeNextPath(bad)).toBe("/trainer");
      // The point of the rule: what the browser would resolve must stay on this origin.
      expect(new URL(safeNextPath(bad), "https://app.example").origin).toBe("https://app.example");
    }
  });
  it("is what the start route stores for an encoded-tab next", async () => {
    const res = await start(new NextRequest("http://localhost/api/auth/google/start?next=%2F%09%2Fevil.example"));
    const flow = verifyFlowState(/g_oauth=([^;]+)/.exec(res.headers.get("set-cookie")!)![1])!;
    expect(flow.next).toBe("/trainer");
  });
});

describe("PKCE, state and flow cookie", () => {
  const flow = { state: "state-0123456789abcdef", verifier: "v".repeat(64), nonce: "nonce-0123456789abcdef", next: "/library" };
  it("generates distinct random values and an S256 challenge", () => {
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken(48).length).toBeGreaterThanOrEqual(43);
    // RFC 7636 appendix B test vector.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("round-trips the signed flow state and rejects tampering", () => {
    const token = signFlowState(flow);
    expect(verifyFlowState(token)).toEqual(flow);
    expect(verifyFlowState(undefined)).toBeNull();
    expect(verifyFlowState(token.slice(0, -2) + "xx")).toBeNull();
    expect(verifyFlowState(jwt.sign({ ...flow }, process.env.JWT_SECRET!))).toBeNull();
  });
  it("asks Google for openid email profile with PKCE S256, state and nonce", () => {
    const cfg = googleConfig()!;
    const url = new URL(authorizeUrl(cfg, flow));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(flow.verifier));
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe("https://calltrainer.example/api/auth/google/callback");
    expect(url.toString()).not.toContain("secret-1");
    expect(url.toString()).not.toContain(flow.verifier);
  });
});

describe("disabled states", () => {
  it.each([
    ["client id", { GOOGLE_CLIENT_ID: "" }],
    ["client secret", { GOOGLE_CLIENT_SECRET: "" }],
    ["APP_URL", { APP_URL: "" }],
    ["demo mode", { DEMO_MODE: "true" }],
  ])("is off without %s: capability false and both routes 404", async (_n, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    expect(googleConfig()).toBeNull();
    expect(getCapabilities().google).toBe(false);
    const s = await start(new NextRequest("http://localhost/api/auth/google/start"));
    expect(s.status).toBe(404);
    const c = await callback(new NextRequest("http://localhost/api/auth/google/callback?code=x&state=y"));
    expect(c.status).toBe(404);
  });
  it("never uses the Host header for the redirect URI", () => {
    expect(googleConfig()!.redirectUri).toBe("https://calltrainer.example/api/auth/google/callback");
  });
  it("is on with all three settings", () => {
    expect(getCapabilities().google).toBe(true);
  });
});

describe("GET /api/auth/google/start", () => {
  it("redirects to Google and sets the httpOnly flow cookie", async () => {
    const res = await start(new NextRequest("http://localhost/api/auth/google/start?next=//evil.example"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${GOOGLE_FLOW_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const flow = verifyFlowState(/g_oauth=([^;]+)/.exec(setCookie)![1])!;
    expect(flow.state).toBe(loc.searchParams.get("state"));
    expect(flow.next).toBe("/trainer");
  });
});

describe("GET /api/auth/google/callback", () => {
  const flow = { state: "state-0123456789abcdef", verifier: "v".repeat(64), nonce: "nonce-0123456789abcdef", next: "/library" };
  const claims = (patch: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com", aud: "client-1", exp: Math.floor(Date.now() / 1000) + 300, sub: "g-sub-1",
    email: "Rep@Example.test", email_verified: true, nonce: flow.nonce, given_name: "Ravi", family_name: "Shah", ...patch,
  });
  const call = (opts: { state?: string; cookie?: string; extraCookie?: string } = {}) => {
    const cookies = [`${GOOGLE_FLOW_COOKIE}=${opts.cookie ?? signFlowState(flow)}`, opts.extraCookie].filter(Boolean).join("; ");
    return callback(new NextRequest(`http://localhost/api/auth/google/callback?code=abc&state=${opts.state ?? flow.state}`, { headers: { cookie: cookies } }));
  };
  const googleReplies = (c: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id_token: jwt.sign(c, "google-key") }), { status: 200 })));
  const loc = (res: Response) => new URL(res.headers.get("location")!, "http://localhost");

  const existing = (patch: Record<string, unknown> = {}) => ({
    id: "u-1", email: "rep@example.test", firstName: "Ravi", lastName: "Shah", role: "owner", googleSub: null,
    mfaEnabled: false, mfaSecret: null, lockedUntil: null, isPlatformAdmin: false, organization: null, ...patch,
  });

  beforeEach(() => {
    for (const m of [mocks.prisma.user.findUnique, mocks.prisma.user.update, mocks.prisma.user.create, mocks.prisma.organization.findUnique, mocks.prisma.organization.create, mocks.prisma.auditEvent.create, mocks.prisma.$transaction]) m.mockReset();
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    mocks.prisma.user.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => existing({ id: where.id, ...data }));
    mocks.prisma.organization.findUnique.mockResolvedValue(null);
    mocks.prisma.organization.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "org-1", ...data }));
    mocks.prisma.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => existing({ id: "u-new", ...data, organization: { id: "org-1", code: "123456" } }));
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: typeof mocks.prisma) => unknown) => fn(mocks.prisma));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a state mismatch without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call({ state: "some-other-state-0123456789" });
    expect(loc(res).pathname).toBe("/login");
    expect(loc(res).searchParams.get("error")).toBe("google_expired");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain(`${GOOGLE_FLOW_COOKIE}=;`);
  });

  it("rejects a missing or forged flow cookie", async () => {
    expect(loc(await call({ cookie: "garbage" })).searchParams.get("error")).toBe("google_expired");
  });

  it("rejects an unverified email and creates nothing", async () => {
    googleReplies(claims({ email_verified: false }));
    const res = await call();
    expect(loc(res).searchParams.get("error")).toBe("google_unverified");
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).not.toContain("authToken=");
  });

  it("sends the code with the PKCE verifier and client secret to Google's token endpoint", async () => {
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.googleSub ? existing({ googleSub: "g-sub-1" }) : null));
    await call();
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init.body);
    expect(body.get("code_verifier")).toBe(flow.verifier);
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("redirect_uri")).toBe("https://calltrainer.example/api/auth/google/callback");
  });

  it("links to an existing user with the same verified email and signs them in", async () => {
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.email === "rep@example.test" ? existing() : null));
    const res = await call();
    expect(mocks.prisma.user.update.mock.calls[0][0]).toMatchObject({ where: { id: "u-1" }, data: { googleSub: "g-sub-1" } });
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
    expect(loc(res).pathname).toBe("/auth/complete");
    expect(loc(res).searchParams.get("next")).toBe("/library");
    const token = /authToken=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    expect(verifySessionToken(token)).toMatchObject({ id: "u-1", email: "rep@example.test" });
    expect(mocks.prisma.auditEvent.create.mock.calls.at(-1)![0].data).toMatchObject({ userId: "u-1", action: "user.login_success", metadata: { via: "google", linked: true } });
  });

  it("does not link an account that already has a different Google id", async () => {
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.email ? existing({ googleSub: "someone-else" }) : null));
    const res = await call();
    expect(loc(res).searchParams.get("error")).toBe("google_failed");
    expect(mocks.prisma.user.update).not.toHaveBeenCalled();
  });

  it("creates a new user as the owner of a solo Free account with no password", async () => {
    googleReplies(claims());
    const res = await call();
    expect(mocks.prisma.organization.create.mock.calls[0][0].data).toMatchObject({ name: "Ravi's team" });
    const data = mocks.prisma.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ email: "rep@example.test", googleSub: "g-sub-1", passwordHash: null, role: "owner", organizationId: "org-1" });
    // Plan and caps come from schema defaults (planTier "free"), exactly as for email signup.
    expect(data).not.toHaveProperty("planTier");
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: "user.registered", metadata: { via: "google" } });
    expect(loc(res).pathname).toBe("/auth/complete");
    expect(res.headers.get("set-cookie")).toContain("authToken=");
  });

  it("refuses a new user behind the access gate, and sends them to /access", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "let-me-in");
    googleReplies(claims());
    const res = await call();
    expect(loc(res).pathname).toBe("/access");
    expect(loc(res).searchParams.get("reason")).toBe("google_invite");
    expect(mocks.prisma.user.create).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).not.toContain("authToken=");
  });

  it("creates a new user behind the gate when the access cookie is valid", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "let-me-in");
    googleReplies(claims());
    const res = await call({ extraCookie: `${ACCESS_COOKIE}=${await accessToken("let-me-in")}` });
    expect(mocks.prisma.user.create).toHaveBeenCalled();
    expect(loc(res).pathname).toBe("/auth/complete");
  });

  it("lets an existing user in behind the gate, like password login", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "let-me-in");
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.googleSub ? existing({ googleSub: "g-sub-1" }) : null));
    const res = await call();
    expect(loc(res).pathname).toBe("/auth/complete");
  });

  it("returns an MFA challenge, not a session, when the user has MFA on", async () => {
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.googleSub ? existing({ googleSub: "g-sub-1", mfaEnabled: true, mfaSecret: "SECRET" }) : null));
    const res = await call();
    expect(loc(res).pathname).toBe("/login");
    const challenge = new URLSearchParams(new URL(res.headers.get("location")!, "http://localhost").hash.slice(1)).get("mfa")!;
    expect(verifyMfaChallengeToken(challenge)).toBe("u-1");
    expect(res.headers.get("set-cookie")).not.toContain("authToken=");
    expect(mocks.prisma.auditEvent.create.mock.calls[0][0].data.action).toBe("user.mfa_challenge_issued");
  });

  it("does not sign in a locked account", async () => {
    googleReplies(claims());
    mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => (where.googleSub ? existing({ googleSub: "g-sub-1", lockedUntil: new Date(Date.now() + 60_000) }) : null));
    const res = await call();
    expect(loc(res).searchParams.get("error")).toBe("locked");
  });

  it("never logs the code, tokens or secrets", async () => {
    googleReplies(claims({ email_verified: false }));
    await call();
    const logged = JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls);
    for (const secret of ["abc", "secret-1", flow.verifier, "google-key"]) expect(logged).not.toContain(secret);
  });
});

describe("password login for a Google-only account", () => {
  it("never matches", async () => {
    const { verifyPassword } = await import("@/lib/auth");
    expect(await verifyPassword("anything", null)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword("", null)).toEqual({ ok: false, needsRehash: false });
  });
});

describe("GET /api/auth/session", () => {
  it("is 401 without the session cookie", async () => {
    const res = await sessionRoute(new NextRequest("http://localhost/api/auth/session"));
    expect(res.status).toBe(401);
  });
});

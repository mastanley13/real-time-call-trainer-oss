import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// An accepted team invite counts as site access. The database, the session check and the rate limiter are the only
// fakes; the middleware, the gate route, register, accept and both Google routes run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  ipLimitResponse: () => null,
  userLimitResponse: () => null,
  rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => {
    const u = mocks.fake.rows("user").find((r) => r.id === mocks.authId);
    return { id: mocks.authId, email: (u?.email as string) ?? `${mocks.authId}@example.test` };
  },
  isDemoUser: () => false,
}));

import { middleware } from "@/middleware";
import { GET as gate } from "@/app/api/invites/gate/[token]/route";
import { POST as acceptInvite } from "@/app/api/invites/accept/route";
import { POST as register } from "@/app/api/auth/register/route";
import { GET as googleStart } from "@/app/api/auth/google/start/route";
import { GET as googleCallback } from "@/app/api/auth/google/callback/route";
import { POST as enterCode } from "@/app/api/access/route";
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessToken } from "@/lib/access";
import { GOOGLE_FLOW_COOKIE, signFlowState, verifyFlowState } from "@/lib/googleAuth";
import { INVITE_PASS_COOKIE, signInvitePass } from "@/lib/invitePass";

const CODE = "letmein";
const SECRET = "test-only-secret-0123456789abcdef";
const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const VALID = "v".repeat(43);
const OTHER = "o".repeat(43);
const EMAIL = "ana@example.test";

let fake: ReturnType<typeof createFakePrisma>;

function seedInvite(token: string, patch: Record<string, unknown> = {}) {
  return fake.seed("teamInvite", {
    organizationId: "org-1", email: EMAIL, role: "manager", tokenHash: sha256(token), invitedById: "owner-1",
    expiresAt: new Date(Date.now() + 3 * DAY), sentAt: new Date(), ...patch,
  });
}
const invite = (token: string) => fake.rows("teamInvite").find((i) => i.tokenHash === sha256(token))!;

const req = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const location = (res: Response) => {
  const to = res.headers.get("location");
  return to ? new URL(to, "http://localhost:3000") : null;
};
const passed = (res: Response) => res.status === 200 && !res.headers.get("location");
const cookieValue = (res: Response, name: string) => res.headers.get("set-cookie")?.match(new RegExp(`(?:^|, )${name}=([^;]*)`))?.[1];
/** The full Set-Cookie entry for `name`, flags included. */
const cookieEntry = (res: Response, name: string) => res.headers.get("set-cookie")?.split(/, (?=[A-Za-z_]+=)/).find((c) => c.startsWith(`${name}=`));
const accessCookie = async () => `${ACCESS_COOKIE}=${await accessToken(CODE)}`;

/** Runs the real gate route and returns the pass cookie header for the invite. */
async function passFor(token: string) {
  const res = await gate(req(`/api/invites/gate/${token}`), { params: Promise.resolve({ token }) });
  const value = cookieValue(res, INVITE_PASS_COOKIE);
  expect(value, "the gate should issue a pass").toBeTruthy();
  return `${INVITE_PASS_COOKIE}=${value}`;
}

/** The middleware's verdict on the app's own pages and APIs with `cookie`. */
async function opensApp(cookie: string) {
  const results = await Promise.all(["/trainer", "/dashboard", "/settings", "/api/config"].map(async (p) => passed(await middleware(req(p, { cookie })))));
  return results.every(Boolean);
}

beforeEach(() => {
  vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
  vi.stubEnv("JWT_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-1");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret-1");
  vi.stubEnv("APP_URL", "https://calltrainer.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "";
  fake.seed("organization", { id: "org-1", code: "101", name: "Harbor Point", planTier: "team", seatCount: 5 });
  fake.seed("user", { id: "owner-1", email: "owner@harborpoint.example", organizationId: "org-1", role: "owner" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("email sign-up from an invite grants site access on accept", () => {
  const signup = (cookie: string, token = VALID) =>
    register(req("/api/auth/register", { method: "POST", cookie, body: { firstName: "Ana", lastName: "Diaz", email: EMAIL, password: "correct-horse-battery", inviteToken: token } }));
  const accept = (cookie: string, token = VALID) => acceptInvite(req("/api/invites/accept", { method: "POST", cookie, body: { token } }));

  async function registerWithPass(token = VALID) {
    const cookie = await passFor(token);
    const res = await signup(cookie, token);
    expect(res.status).toBe(200);
    mocks.authId = fake.rows("user").find((u) => u.email === EMAIL)!.id;
    return cookie;
  }

  it("register, then accept: the response sets the same access cookie /api/access sets, and clears the pass", async () => {
    seedInvite(VALID);
    const pass = await registerWithPass();
    expect(await opensApp(pass)).toBe(false);

    const res = await accept(pass);
    expect(res.status).toBe(200);
    expect(invite(VALID).acceptedAt).toBeInstanceOf(Date);
    expect(fake.rows("user").find((u) => u.email === EMAIL)).toMatchObject({ organizationId: "org-1", role: "manager" });

    const granted = cookieEntry(res, ACCESS_COOKIE)!;
    expect(cookieValue(res, ACCESS_COOKIE)).toBe(await accessToken(CODE));
    expect(granted).toMatch(/HttpOnly/i);
    expect(granted).toMatch(/SameSite=lax/i);
    expect(granted).toMatch(/Path=\//);
    expect(granted).toContain(`Max-Age=${ACCESS_MAX_AGE}`);
    expect(cookieEntry(res, INVITE_PASS_COOKIE)).toMatch(/Max-Age=0/);

    // Byte for byte what entering the code sets.
    const viaCode = await enterCode(req("/api/access", { method: "POST", body: { code: CODE } }));
    expect(cookieEntry(viaCode, ACCESS_COOKIE)).toBe(granted);
  });

  it("the middleware lets the granted cookie through to the whole app", async () => {
    seedInvite(VALID);
    const pass = await registerWithPass();
    const res = await accept(pass);
    const cookie = `${ACCESS_COOKIE}=${cookieValue(res, ACCESS_COOKIE)}`;
    expect(await opensApp(cookie)).toBe(true);
    expect(await opensApp(`${ACCESS_COOKIE}=${"0".repeat(64)}`)).toBe(false);
  });

  it("registering alone grants nothing: the invite is not accepted yet", async () => {
    seedInvite(VALID);
    const cookie = await passFor(VALID);
    const res = await signup(cookie);
    expect(res.status).toBe(200);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1000) }, 410],
    ["revoked", { revokedAt: new Date() }, 404],
    ["already used", { acceptedAt: new Date(), acceptedById: "someone" }, 410],
  ])("an invite %s by the time of accept gets no access cookie", async (_kind, patch, status) => {
    seedInvite(VALID);
    const pass = await registerWithPass();
    Object.assign(invite(VALID), patch);
    const res = await accept(pass);
    expect(res.status).toBe(status);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
  });

  it("an unknown invite gets no access cookie, even with a validly signed pass for its token", async () => {
    fake.seed("user", { id: "u-ana", email: EMAIL });
    mocks.authId = "u-ana";
    const pass = await signInvitePass({ inviteId: "teamInvite-404", tokenHash: sha256(VALID), expiresAt: Date.now() + 10 * 60_000 });
    const res = await accept(`${INVITE_PASS_COOKIE}=${pass}`);
    expect(res.status).toBe(404);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
  });

  it("a tampered pass gets 401 and no access cookie", async () => {
    seedInvite(VALID);
    const pass = await registerWithPass();
    const [name, value] = pass.split("=");
    const parts = value.split(".");
    parts[3] = (parts[3][0] === "a" ? "b" : "a") + parts[3].slice(1);
    const res = await accept(`${name}=${parts.join(".")}`);
    expect(res.status).toBe(401);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(invite(VALID).acceptedAt).toBeNull();
  });

  it("a pass for invite A cannot accept invite B", async () => {
    seedInvite(VALID);
    seedInvite(OTHER);
    const passA = await registerWithPass(VALID);
    const res = await accept(passA, OTHER);
    expect(res.status).toBe(401);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(invite(OTHER).acceptedAt).toBeNull();
  });

  it("is single use: a second accept of the same invite gets no access cookie", async () => {
    seedInvite(VALID);
    const pass = await registerWithPass();
    expect((await accept(pass)).status).toBe(200);
    const again = await accept(pass);
    expect(again.status).toBe(410);
    expect(cookieValue(again, ACCESS_COOKIE)).toBeUndefined();
  });

  it("without TRAINER_ACCESS_CODE, accepting sets no access cookie", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "");
    seedInvite(VALID);
    fake.seed("user", { id: "u-ana", email: EMAIL });
    mocks.authId = "u-ana";
    const res = await accept("");
    expect(res.status).toBe(200);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
  });
});

describe("Google sign-up from an invite grants site access", () => {
  const claims = (nonce: string, patch: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com", aud: "client-1", exp: Math.floor(Date.now() / 1000) + 300, sub: "g-sub-ana",
    email: EMAIL, email_verified: true, nonce, given_name: "Ana", family_name: "Diaz", ...patch,
  });

  /** /start with `cookie` and next=/invite/<token>; returns the signed flow cookie and what it carries. */
  async function start(cookie: string, token = VALID) {
    const res = await googleStart(req(`/api/auth/google/start?next=${encodeURIComponent(`/invite/${token}`)}`, { cookie }));
    expect(res.status).toBe(307);
    const value = cookieValue(res, GOOGLE_FLOW_COOKIE)!;
    return { value, flow: verifyFlowState(value)! };
  }

  /** Google's answer, then /callback with the flow cookie (and any extra cookies). */
  function callback(flowCookie: string, flow: { state: string; nonce: string }, opts: { claims?: Record<string, unknown>; extraCookie?: string } = {}) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id_token: jwt.sign(claims(flow.nonce, opts.claims), "google-key") }), { status: 200 })));
    const cookie = [`${GOOGLE_FLOW_COOKIE}=${flowCookie}`, opts.extraCookie].filter(Boolean).join("; ");
    return googleCallback(req(`/api/auth/google/callback?code=abc&state=${flow.state}`, { cookie }));
  }

  const ana = () => fake.rows("user").find((u) => u.email === EMAIL);
  const gated = (res: Response) => {
    expect(location(res)!.pathname).toBe("/access");
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(cookieValue(res, "authToken")).toBeUndefined();
  };

  it("start binds the invite into the signed flow only for the matching pass", async () => {
    seedInvite(VALID);
    seedInvite(OTHER);
    const passA = await passFor(VALID);
    expect((await start(passA, VALID)).flow.invite).toBe(VALID);
    // A pass for A does not carry invite B.
    expect((await start(passA, OTHER)).flow.invite).toBeUndefined();
    // No pass, or the access code already, or the gate off: nothing is bound.
    expect((await start("", VALID)).flow.invite).toBeUndefined();
    expect((await start(await accessCookie(), VALID)).flow.invite).toBeUndefined();
    vi.stubEnv("TRAINER_ACCESS_CODE", "");
    expect((await start(passA, VALID)).flow.invite).toBeUndefined();
  });

  it("a brand-new account joins the team, the invite is accepted, and the response grants site access", async () => {
    seedInvite(VALID);
    const pass = await passFor(VALID);
    const { value, flow } = await start(pass);
    const res = await callback(value, flow, { extraCookie: pass });

    expect(location(res)!.pathname).toBe("/auth/complete");
    expect(location(res)!.searchParams.get("next")).toBe("/trainer");
    expect(ana()).toMatchObject({ organizationId: "org-1", role: "manager", googleSub: "g-sub-ana", passwordHash: null });
    expect(invite(VALID)).toMatchObject({ acceptedById: ana()!.id });
    expect(cookieValue(res, "authToken")).toBeTruthy();
    expect(cookieValue(res, ACCESS_COOKIE)).toBe(await accessToken(CODE));
    expect(cookieEntry(res, ACCESS_COOKIE)).toContain(`Max-Age=${ACCESS_MAX_AGE}`);
    expect(cookieEntry(res, INVITE_PASS_COOKIE)).toMatch(/Max-Age=0/);

    // The middleware lets the granted cookie through.
    expect(await opensApp(`${ACCESS_COOKIE}=${cookieValue(res, ACCESS_COOKIE)}`)).toBe(true);
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
    ["revoked", { revokedAt: new Date() }],
    ["already used", { acceptedAt: new Date(), acceptedById: "someone" }],
  ])("an invite %s between start and callback is re-checked: no account, gated", async (_kind, patch) => {
    seedInvite(VALID);
    const { value, flow } = await start(await passFor(VALID));
    Object.assign(invite(VALID), patch);
    gated(await callback(value, flow));
    expect(ana()).toBeUndefined();
  });

  it("an unknown invite (deleted or replaced by a resend) creates nothing and is gated", async () => {
    seedInvite(VALID);
    const { value, flow } = await start(await passFor(VALID));
    invite(VALID).tokenHash = sha256(OTHER);
    gated(await callback(value, flow));
    expect(ana()).toBeUndefined();
  });

  it("a tampered flow cookie (invite swapped without the signing key) is refused", async () => {
    seedInvite(VALID);
    seedInvite(OTHER);
    const { value, flow } = await start(await passFor(VALID));
    const forged = signFlowState({ ...flow, invite: OTHER }).replace(/\.[^.]+$/, `.${value.split(".")[2]}`);
    const res = await callback(forged, flow);
    expect(location(res)!.pathname).toBe("/login");
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(ana()).toBeUndefined();
    expect(invite(OTHER).acceptedAt).toBeNull();
  });

  it("a pass for invite A started toward invite B is gated, and B stays open", async () => {
    seedInvite(VALID);
    seedInvite(OTHER);
    const passA = await passFor(VALID);
    const { value, flow } = await start(passA, OTHER);
    gated(await callback(value, flow, { extraCookie: passA }));
    expect(ana()).toBeUndefined();
    expect(invite(OTHER).acceptedAt).toBeNull();
    expect(invite(VALID).acceptedAt).toBeNull();
  });

  it("is atomic: when another accept claims the invite first, the new account is rolled back and gated", async () => {
    seedInvite(VALID);
    fake.seed("user", { id: "u-rival", email: "rival@example.test" });
    const { value, flow } = await start(await passFor(VALID));
    fake.interleave("teamInvite", "updateMany", async () => {
      await fake.db.teamInvite.updateMany({ where: { tokenHash: sha256(VALID) }, data: { acceptedAt: new Date(), acceptedById: "u-rival" } });
    });
    gated(await callback(value, flow));
    expect(ana()).toBeUndefined();
    expect(invite(VALID).acceptedById).toBe("u-rival");
  });

  it("a Google address that is not the invited one creates nothing and grants nothing", async () => {
    seedInvite(VALID);
    const { value, flow } = await start(await passFor(VALID));
    const res = await callback(value, flow, { claims: { email: "someone.else@example.test" } });
    expect(location(res)!.pathname).toBe("/login");
    expect(location(res)!.searchParams.get("error")).toBe("google_invite_email");
    expect(location(res)!.searchParams.get("next")).toBe(`/invite/${VALID}`);
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(fake.rows("user").some((u) => u.email === "someone.else@example.test")).toBe(false);
    expect(invite(VALID).acceptedAt).toBeNull();
  });

  it("a full team creates nothing and grants nothing", async () => {
    seedInvite(VALID);
    fake.rows("organization")[0].seatCount = 1;
    const { value, flow } = await start(await passFor(VALID));
    const res = await callback(value, flow);
    expect(location(res)!.searchParams.get("error")).toBe("google_invite_full");
    expect(cookieValue(res, ACCESS_COOKIE)).toBeUndefined();
    expect(ana()).toBeUndefined();
  });

  it("a new account with no invite in the flow is still gated, as before", async () => {
    const { value, flow } = await start("");
    gated(await callback(value, flow));
    expect(ana()).toBeUndefined();
  });
});

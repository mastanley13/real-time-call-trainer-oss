import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// The database, the session check and the rate limiter are the only fakes; the middleware, the gate route and the
// invite and register routes run for real against the access gate.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "newbie" }));
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
import { POST as previewInvite } from "@/app/api/invites/preview/route";
import { POST as register } from "@/app/api/auth/register/route";
import { ACCESS_COOKIE, accessToken } from "@/lib/access";
import { INVITE_PASS_COOKIE, INVITE_PASS_TTL_MS, readInvitePass, signInvitePass } from "@/lib/invitePass";

const CODE = "letmein";
const SECRET = "test-only-secret-0123456789abcdef";
const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const tokenFor = (c: string) => c.repeat(43);
const VALID = tokenFor("v");
const OTHER = tokenFor("o");

let fake: ReturnType<typeof createFakePrisma>;

function seedInvite(token: string, patch: Record<string, unknown> = {}) {
  return fake.seed("teamInvite", {
    organizationId: "org-1", email: "rep@example.test", tokenHash: sha256(token), invitedById: "owner-1",
    expiresAt: new Date(Date.now() + 3 * DAY), sentAt: new Date(), ...patch,
  });
}

const req = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const location = (res: Response) => {
  const to = res.headers.get("location");
  return to ? new URL(to) : null;
};
const passed = (res: Response) => res.status === 200 && !res.headers.get("location");
const passCookie = (res: Response) => res.headers.get("set-cookie")?.match(new RegExp(`${INVITE_PASS_COOKIE}=([^;]*)`))?.[1];

/** Runs the gate route for a token and returns the pass cookie it set, if any. */
async function openInvite(token: string) {
  const res = await gate(req(`/api/invites/gate/${token}`), { params: Promise.resolve({ token }) });
  return { res, pass: passCookie(res) };
}

beforeEach(() => {
  vi.stubEnv("TRAINER_ACCESS_CODE", CODE);
  vi.stubEnv("JWT_SECRET", SECRET);
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("DEMO_MODE", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "newbie";
  fake.seed("organization", { id: "org-1", code: "101", name: "Harbor Point", planTier: "team", seatCount: 5 });
  fake.seed("user", { id: "owner-1", email: "owner@harborpoint.example", organizationId: "org-1", role: "owner" });
  fake.seed("user", { id: "newbie", email: "rep@example.test" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("access gate: invite links", () => {
  it("a valid invite passes: the link goes to the gate route, which sets a scoped pass and sends it back", async () => {
    seedInvite(VALID);
    const first = await middleware(req(`/invite/${VALID}`));
    expect(first.status).toBe(307);
    expect(location(first)!.pathname).toBe(`/api/invites/gate/${VALID}`);
    // The gate route itself is reachable without the code; it is where the database check happens.
    expect(passed(await middleware(req(`/api/invites/gate/${VALID}`)))).toBe(true);

    const { res, pass } = await openInvite(VALID);
    expect(res.status).toBe(303);
    expect(location(res)!.pathname).toBe(`/invite/${VALID}`);
    expect(pass).toBeTruthy();
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=lax/i);
    expect(Number(header.match(/Max-Age=(\d+)/i)![1])).toBeLessThanOrEqual(INVITE_PASS_TTL_MS / 1000);
    // The pass carries the token's hash, never the token.
    expect(decodeURIComponent(pass!)).not.toContain(VALID);

    const cookie = `${INVITE_PASS_COOKIE}=${pass}`;
    expect(passed(await middleware(req(`/invite/${VALID}?pass=1`, { cookie })))).toBe(true);
    expect(passed(await middleware(req(`/invite/${VALID}`, { cookie })))).toBe(true);
    for (const api of ["/api/invites/preview", "/api/invites/accept"]) {
      expect(passed(await middleware(req(api, { method: "POST", cookie }))), api).toBe(true);
    }
  });

  it("lasts no longer than the invite itself", async () => {
    seedInvite(VALID, { expiresAt: new Date(Date.now() + 5 * 60_000) });
    const { pass } = await openInvite(VALID);
    const read = await readInvitePass(decodeURIComponent(pass!));
    expect(read!.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it.each([
    ["unknown", () => undefined],
    ["expired", () => seedInvite(VALID, { expiresAt: new Date(Date.now() - 1000) })],
    ["revoked", () => seedInvite(VALID, { revokedAt: new Date() })],
    ["accepted", () => seedInvite(VALID, { acceptedAt: new Date(), acceptedById: "someone" })],
  ])("an %s invite gets no pass and lands on /access", async (_kind, arrange) => {
    arrange();
    const { res, pass } = await openInvite(VALID);
    expect(pass).toBeUndefined();
    expect(location(res)!.pathname).toBe("/access");
    expect(location(res)!.searchParams.get("next")).toBe(`/invite/${VALID}`);
  });

  it("a malformed invite path goes straight to /access", async () => {
    const res = await middleware(req("/invite/not-a-token"));
    expect(location(res)!.pathname).toBe("/access");
  });

  it("a browser that drops the cookie lands on /access instead of looping", async () => {
    seedInvite(VALID);
    const res = await middleware(req(`/invite/${VALID}?pass=1`));
    expect(location(res)!.pathname).toBe("/access");
    expect(location(res)!.searchParams.get("next")).toBe(`/invite/${VALID}`);
  });

  it("fails closed without a usable JWT_SECRET: no pass is issued, and an old one stops verifying", async () => {
    seedInvite(VALID);
    const { pass } = await openInvite(VALID);
    vi.stubEnv("JWT_SECRET", "");
    const again = await openInvite(VALID);
    expect(again.pass).toBeUndefined();
    expect(location(again.res)!.pathname).toBe("/access");
    const res = await middleware(req(`/invite/${VALID}?pass=1`, { cookie: `${INVITE_PASS_COOKIE}=${pass}` }));
    expect(location(res)!.pathname).toBe("/access");
  });

  it("with the gate off, the gate route just goes to the invite and sets nothing", async () => {
    vi.stubEnv("TRAINER_ACCESS_CODE", "");
    const { res, pass } = await openInvite(VALID);
    expect(pass).toBeUndefined();
    expect(location(res)!.pathname).toBe(`/invite/${VALID}`);
  });
});

describe("access gate: the pass cookie", () => {
  const pass = async (patch: Partial<{ inviteId: string; tokenHash: string; expiresAt: number }> = {}) =>
    (await signInvitePass({ inviteId: "teamInvite-1", tokenHash: sha256(VALID), expiresAt: Date.now() + 10 * 60_000, ...patch }))!;
  const gatedBy = async (value: string, path = `/invite/${VALID}?pass=1`) => location(await middleware(req(path, { cookie: `${INVITE_PASS_COOKIE}=${value}` })))?.pathname;

  it("rejects a tampered signature, token hash, invite id or expiry", async () => {
    const good = await pass();
    const [id, hash, exp, sig] = good.split(".");
    const flip = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
    for (const bad of [
      [id, hash, exp, flip(sig)].join("."),
      [id, sha256(OTHER), exp, sig].join("."),
      ["teamInvite-2", hash, exp, sig].join("."),
      [id, hash, String(Number(exp) + 60_000), sig].join("."),
      `${good}.extra`,
      "garbage",
    ]) {
      expect(await gatedBy(bad), bad).toBe("/access");
    }
    expect(await gatedBy(good)).toBeUndefined();
  });

  it("rejects an expired pass, and one claiming to outlive the 30 minute limit", async () => {
    expect(await gatedBy(await pass({ expiresAt: Date.now() - 1 }))).toBe("/access");
    expect(await gatedBy(await pass({ expiresAt: Date.now() + INVITE_PASS_TTL_MS + 60_000 }))).toBe("/access");
  });

  it("expires on the clock: good now, refused 31 minutes later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    seedInvite(VALID);
    const { pass: value } = await openInvite(VALID);
    expect(await gatedBy(value!)).toBeUndefined();
    vi.setSystemTime(new Date("2026-11-04T12:31:00Z"));
    expect(await gatedBy(value!)).toBe("/access");
  });

  it("opens nothing else: other pages redirect to /access and other APIs answer 401", async () => {
    seedInvite(VALID);
    const { pass: value } = await openInvite(VALID);
    const cookie = `${INVITE_PASS_COOKIE}=${value}`;
    for (const page of ["/dashboard", "/settings", "/settings/members", "/settings/billing", "/trainer", "/team", "/library", "/checkout/start"]) {
      const res = await middleware(req(page, { cookie }));
      expect(location(res)?.pathname, page).toBe("/access");
    }
    for (const api of ["/api/team/members", "/api/team/invites", "/api/team/overview", "/api/config", "/api/transcripts", "/api/me", "/api/usage", "/api/invites/other"]) {
      const res = await middleware(req(api, { method: "POST", cookie }));
      expect(res.status, api).toBe(401);
    }
    // Another invite's page is not this pass's to open: it goes to the gate route for its own check.
    const other = await middleware(req(`/invite/${OTHER}`, { cookie }));
    expect(location(other)!.pathname).toBe(`/api/invites/gate/${OTHER}`);
  });
});

describe("access gate: routes the pass opens check the token too", () => {
  const preview = (token: string, cookie?: string) => previewInvite(req("/api/invites/preview", { method: "POST", cookie, body: { token } }));
  const accept = (token: string, cookie?: string) => acceptInvite(req("/api/invites/accept", { method: "POST", cookie, body: { token } }));

  it("refuses a request with no pass, or with a pass for a different invite (401)", async () => {
    seedInvite(VALID);
    seedInvite(OTHER, { email: "other@example.test" });
    const { pass } = await openInvite(VALID);
    for (const res of [await preview(VALID), await accept(VALID), await preview(OTHER, `${INVITE_PASS_COOKIE}=${pass}`), await accept(OTHER, `${INVITE_PASS_COOKIE}=${pass}`)]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "access_code_required" });
    }
    expect(fake.rows("teamInvite").every((i) => !i.acceptedAt)).toBe(true);
  });

  it("accepts with the matching pass, clears the pass, and grants site access", async () => {
    seedInvite(VALID);
    const { pass } = await openInvite(VALID);
    const cookie = `${INVITE_PASS_COOKIE}=${pass}`;
    expect((await preview(VALID, cookie)).status).toBe(200);
    const res = await accept(VALID, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${INVITE_PASS_COOKIE}=;[^,]*Max-Age=0`, "i"));
    expect(res.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE}=${await accessToken(CODE)}`);
  });

  it("with the access code, works as before and needs no pass", async () => {
    seedInvite(VALID);
    const cookie = `${ACCESS_COOKIE}=${await accessToken(CODE)}`;
    const res = await accept(VALID, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("access gate: sign-up from an invite", () => {
  const signup = (extra: Record<string, unknown>, cookie?: string) =>
    register(req("/api/auth/register", { method: "POST", cookie, body: { firstName: "Ana", lastName: "Diaz", email: "ana@example.test", password: "correct-horse-battery", ...extra } }));

  beforeEach(() => { seedInvite(VALID, { email: "ana@example.test" }); });

  it("allows signing up for the invite the pass was issued for", async () => {
    const { pass } = await openInvite(VALID);
    const res = await signup({ inviteToken: VALID }, `${INVITE_PASS_COOKIE}=${pass}`);
    expect(res.status).toBe(200);
    expect(fake.rows("user").find((u) => u.email === "ana@example.test")).toMatchObject({ organizationId: null });
  });

  it("refuses any other sign-up with only a pass: a new team, a join code, or another invite's token", async () => {
    seedInvite(OTHER, { email: "ana@example.test" });
    const { pass } = await openInvite(VALID);
    const cookie = `${INVITE_PASS_COOKIE}=${pass}`;
    for (const extra of [{ newOrgName: "Sneaky Team" }, { joinOrgCode: "101" }, { inviteToken: OTHER }]) {
      const res = await signup(extra, cookie);
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
    expect(fake.rows("user").some((u) => u.email === "ana@example.test")).toBe(false);
  });

  it("refuses sign-up with no pass and no code, as before", async () => {
    expect((await signup({ inviteToken: VALID })).status).toBe(403);
  });
});

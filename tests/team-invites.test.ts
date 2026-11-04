import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// The database, the session check and the rate limiter are the only fakes; every invite route runs for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "owner-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), ipLimitResponse: () => null, userLimitResponse: () => null }));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => {
    const u = mocks.fake.rows("user").find((r) => r.id === mocks.authId);
    return { id: mocks.authId, email: (u?.email as string) ?? `${mocks.authId}@example.test` };
  },
  isDemoUser: () => false,
}));

import { GET as listMembers } from "@/app/api/team/members/route";
import { DELETE as removeMember } from "@/app/api/team/members/[id]/route";
import { POST as createInvites } from "@/app/api/team/invites/route";
import { DELETE as revokeInvite } from "@/app/api/team/invites/[id]/route";
import { POST as resendInvite } from "@/app/api/team/invites/[id]/resend/route";
import { POST as acceptInvite } from "@/app/api/invites/accept/route";
import { POST as previewInvite } from "@/app/api/invites/preview/route";
import { POST as register } from "@/app/api/auth/register/route";
import {
  fitsSeats, INVITE_TTL_MS, inviteStatus, inviteTokenFromPath, joinBlock, maskEmail, membersAccess, parseEmailList, removeBlock, seatsFullMessage,
  type MembersPayload,
} from "@/lib/invites";
import { buildSampleMembers } from "@/lib/membersSample";

const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let fake: ReturnType<typeof createFakePrisma>;
const as = (id: string) => { mocks.authId = id; };
const user = (id: string) => fake.rows("user").find((u) => u.id === id)!;
const invites = () => fake.rows("teamInvite");

const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const create = (emails: string[], role?: "trainee" | "manager") => createInvites(json("/api/team/invites", "POST", { emails, ...(role ? { role } : {}) }));
const resend = (id: string) => resendInvite(json(`/api/team/invites/${id}/resend`, "POST", {}), params(id));
const revoke = (id: string) => revokeInvite(json(`/api/team/invites/${id}`, "DELETE"), params(id));
const remove = (id: string) => removeMember(json(`/api/team/members/${id}`, "DELETE"), params(id));
const accept = (token: string) => acceptInvite(json("/api/invites/accept", "POST", { token }));
const preview = (token: string) => previewInvite(json("/api/invites/preview", "POST", { token }));
const tokenOf = (link: string) => inviteTokenFromPath(new URL(link).pathname)!;

/** Creates one invite as the owner and returns its id and raw token. */
async function invite(email: string, role?: "trainee" | "manager") {
  as("owner-1");
  const res = await create([email], role);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { invites: { id: string; link: string }[] };
  return { id: body.invites[0].id, token: tokenOf(body.invites[0].link) };
}

/** An invite row written straight to the store, for expiry and seat cases. */
function seedInvite(email: string, opts: { expiresAt?: Date; token?: string; organizationId?: string } = {}) {
  const token = opts.token ?? "t".repeat(42) + String(invites().length % 10);
  const row = fake.seed("teamInvite", {
    organizationId: opts.organizationId ?? "org-1", email, tokenHash: sha256(token), invitedById: "owner-1",
    expiresAt: opts.expiresAt ?? new Date(Date.now() + INVITE_TTL_MS), sentAt: new Date(),
  });
  return { id: row.id, token };
}

const savedEnv = { DATABASE_URL: process.env.DATABASE_URL, DEMO_MODE: process.env.DEMO_MODE };
beforeEach(() => {
  process.env.DATABASE_URL = "postgresql://test@localhost/test";
  delete process.env.DEMO_MODE;
  vi.stubEnv("JWT_SECRET", "test-only-secret-0123456789abcdef");
  vi.stubEnv("APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = createFakePrisma();
  mocks.fake = fake;
  as("owner-1");
  fake.seed("organization", { id: "org-1", code: "101", name: "Harbor Point", planTier: "team", seatCount: 4 });
  fake.seed("organization", { id: "org-free", code: "202", name: "Solo Shop", planTier: "free", seatCount: 1 });
  fake.seed("user", { id: "owner-1", email: "owner@harborpoint.example", firstName: "Mia", lastName: "Chen", organizationId: "org-1", role: "owner", createdAt: new Date(Date.now() - 9 * DAY) });
  fake.seed("user", { id: "mgr-1", email: "jordan@harborpoint.example", firstName: "Jordan", lastName: "Lee", organizationId: "org-1", role: "manager", createdAt: new Date(Date.now() - 8 * DAY) });
  fake.seed("user", { id: "free-owner", email: "solo@soloshop.example", organizationId: "org-free", role: "owner" });
  fake.seed("user", { id: "newbie", email: "rep@example.test", firstName: "Ravi", lastName: "Shah" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("invite rules (pure)", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  it("derives status: accepted and revoked win, then expiry", () => {
    expect(inviteStatus({ expiresAt: new Date(now.getTime() + 1) }, now)).toBe("pending");
    expect(inviteStatus({ expiresAt: now }, now)).toBe("expired");
    expect(inviteStatus({ expiresAt: new Date(now.getTime() + DAY), acceptedAt: now }, now)).toBe("accepted");
    expect(inviteStatus({ expiresAt: new Date(now.getTime() + DAY), revokedAt: now }, now)).toBe("revoked");
  });

  it("counts members plus pending invites against the seat count", () => {
    expect(fitsSeats({ members: 3, pending: 1, seatCount: 5 }, 1)).toBe(true);
    expect(fitsSeats({ members: 3, pending: 1, seatCount: 5 }, 2)).toBe(false);
    expect(fitsSeats({ members: 5, pending: 0, seatCount: 5 }, 1)).toBe(false);
    expect(seatsFullMessage(5)).toBe("All 5 seats are in use. Add seats from Billing to invite more people.");
  });

  it("only lets an owner of a Team-plan organization manage", () => {
    expect(membersAccess({ role: "owner", organizationId: "o" }, { planTier: "team" })).toBe("manage");
    expect(membersAccess({ role: "manager", organizationId: "o" }, { planTier: "team" })).toBe("view");
    expect(membersAccess({ role: "trainee", organizationId: "o" }, { planTier: "team" })).toBe("forbidden");
    expect(membersAccess({ role: "owner", organizationId: "o" }, { planTier: "pro" })).toBe("not_team_plan");
    expect(membersAccess({ role: "owner", organizationId: null }, null)).toBe("no_organization");
  });

  it("blocks removing yourself or the last owner", () => {
    expect(removeBlock("a", { id: "a", role: "owner" }, 2)).toBe("self");
    expect(removeBlock("a", { id: "b", role: "owner" }, 1)).toBe("last_owner");
    expect(removeBlock("a", { id: "b", role: "owner" }, 2)).toBeNull();
    expect(removeBlock("a", { id: "b", role: "trainee" }, 1)).toBeNull();
  });

  it("blocks joining from a team you are the only owner of, when others remain", () => {
    expect(joinBlock({ organizationId: "x", role: "owner" }, "x", null)).toBe("already_member");
    expect(joinBlock({ organizationId: "y", role: "owner" }, "x", { otherMembers: 2, otherOwners: 0 })).toBe("sole_owner");
    expect(joinBlock({ organizationId: "y", role: "owner" }, "x", { otherMembers: 0, otherOwners: 0 })).toBeNull();
    expect(joinBlock({ organizationId: null, role: "trainee" }, "x", null)).toBeNull();
  });

  it("parses typed lists, masks emails and reads invite paths", () => {
    expect(parseEmailList(" A@x.test, b@x.test;\nA@X.test  c@x.test ")).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
    expect(maskEmail("mia@example.test")).toBe("m**@example.test");
    expect(inviteTokenFromPath(`/invite/${"a".repeat(43)}`)).toBe("a".repeat(43));
    expect(inviteTokenFromPath(`/invite/${"a".repeat(43)}/x`)).toBeNull();
    expect(inviteTokenFromPath("/trainer")).toBeNull();
  });

  it("builds demo data with pending, expired and full states", () => {
    const viewer = { id: "demo-user", name: "Demo User", email: "demo@example.local" };
    const base = buildSampleMembers("default", now, viewer);
    expect(base.seats).toEqual({ used: 4, total: 5 });
    expect(base.invites.map((i) => i.status)).toEqual(["pending", "expired"]);
    expect(buildSampleMembers("full", now, viewer).seats).toEqual({ used: 5, total: 5 });
  });
});

describe("create invites", () => {
  it("stores only the sha256 of the token, lowercased, expiring in 7 days, and returns the link once", async () => {
    const before = Date.now();
    const res = await create(["New.Rep@Example.test"]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invites: { email: string; status: string; link: string }[] };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ email: "new.rep@example.test", status: "pending" });
    expect(body.invites[0].link).toMatch(/^http:\/\/localhost\/invite\/[A-Za-z0-9_-]{43}$/);

    const token = tokenOf(body.invites[0].link);
    const [row] = invites();
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(fake.rows("teamInvite"))).not.toContain(token);
    expect(JSON.stringify(fake.rows("auditEvent"))).not.toContain(token);
    expect((row.expiresAt as Date).getTime() - before).toBeGreaterThanOrEqual(INVITE_TTL_MS - 1000);
    expect((row.expiresAt as Date).getTime() - before).toBeLessThanOrEqual(INVITE_TTL_MS + 1000);
    expect(fake.rawQueries.some((q) => q.sql.includes("FOR UPDATE"))).toBe(true);
  });

  it("refuses someone already on the team or already invited", async () => {
    const member = await create(["Jordan@HarborPoint.example"]);
    expect(member.status).toBe(409);
    expect(await member.json()).toMatchObject({ error: "already_member" });
    await invite("rep@example.test");
    const again = await create(["rep@example.test"]);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_invited" });
  });

  it("returns 409 seats_full when members plus pending invites would pass the seat count", async () => {
    // 4 seats: 2 members, so 2 invites fit and a third does not.
    const tooMany = await create(["a@example.test", "b@example.test", "c@example.test"]);
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toEqual({ error: "seats_full", message: "All 4 seats are in use. Add seats from Billing to invite more people.", seats: 4 });
    expect(invites()).toHaveLength(0);

    expect((await create(["a@example.test", "b@example.test"])).status).toBe(201);
    const full = await create(["c@example.test"]);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "seats_full" });
  });

  it("frees the seat of an expired invite", async () => {
    seedInvite("old1@example.test", { expiresAt: new Date(Date.now() - DAY) });
    seedInvite("old2@example.test", { expiresAt: new Date(Date.now() - DAY) });
    expect((await create(["a@example.test", "b@example.test"])).status).toBe(201);
  });

  it("rejects bad input with 400", async () => {
    expect((await create(["not-an-email"])).status).toBe(400);
    expect((await create([])).status).toBe(400);
  });
});

describe("permissions", () => {
  it("lets a manager read the page but not change it (403)", async () => {
    as("mgr-1");
    const list = await listMembers(json("/api/team/members", "GET"));
    expect(list.status).toBe(200);
    expect(((await list.json()) as MembersPayload).access).toBe("view");

    const { id } = seedInvite("rep@example.test");
    as("mgr-1");
    for (const res of [await create(["x@example.test"]), await resend(id), await revoke(id), await remove("owner-1")]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "forbidden" });
    }
    expect(invites()[0].revokedAt).toBeNull();
    expect(user("owner-1").organizationId).toBe("org-1");
  });

  it("refuses a trainee and an owner without the Team plan", async () => {
    fake.seed("user", { id: "rep-1", email: "rep1@harborpoint.example", organizationId: "org-1", role: "trainee" });
    as("rep-1");
    expect((await listMembers(json("/api/team/members", "GET"))).status).toBe(403);
    expect((await create(["x@example.test"])).status).toBe(403);

    as("free-owner");
    const res = await create(["x@example.test"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "team_plan_required" });
  });

  it("lists members, open invites and seats for the owner", async () => {
    await invite("rep@example.test");
    seedInvite("old@example.test", { expiresAt: new Date(Date.now() - DAY) });
    const res = await listMembers(json("/api/team/members", "GET"));
    const body = (await res.json()) as MembersPayload;
    expect(body.access).toBe("manage");
    expect(body.members.map((m) => m.id)).toEqual(["owner-1", "mgr-1"]);
    expect(body.invites.map((i) => [i.email, i.status])).toEqual([["rep@example.test", "pending"], ["old@example.test", "expired"]]);
    expect(body.seats).toEqual({ used: 3, total: 4 });
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("serves the sample page in demo mode, with ?demo=full for every seat taken", async () => {
    process.env.DEMO_MODE = "true";
    const full = (await (await listMembers(json("/api/team/members?demo=full", "GET"))).json()) as MembersPayload;
    expect(full.sample).toBe(true);
    expect(full.seats).toEqual({ used: 5, total: 5 });
    const res = await createInvites(json("/api/team/invites?demo=full", "POST", { emails: ["x@example.test"] }));
    expect(res.status).toBe(409);
    expect(invites()).toHaveLength(0);
  });
});

describe("resend", () => {
  it("rotates the token and extends the expiry; the old link stops working", async () => {
    const { id, token: oldToken } = seedInvite("rep@example.test", { expiresAt: new Date(Date.now() + DAY) });
    const res = await resend(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; invite: { status: string; expiresAt: string } };
    const newToken = tokenOf(body.link);
    expect(newToken).not.toBe(oldToken);
    expect(invites()[0].tokenHash).toBe(sha256(newToken));
    expect(new Date(body.invite.expiresAt).getTime()).toBeGreaterThan(Date.now() + INVITE_TTL_MS - 5000);

    as("newbie");
    expect((await accept(oldToken)).status).toBe(404);
    expect((await accept(newToken)).status).toBe(200);
  });

  it("revives an expired invite only when a seat is free", async () => {
    const { id } = seedInvite("rep@example.test", { expiresAt: new Date(Date.now() - DAY) });
    seedInvite("a@example.test");
    seedInvite("b@example.test");
    // 2 members + 2 pending = 4 of 4: reviving would make 5.
    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "seats_full" });
  });

  it("does not resend another team's invite", async () => {
    fake.seed("organization", { id: "org-2", code: "303", name: "Other", planTier: "team", seatCount: 9 });
    const { id } = seedInvite("x@example.test", { organizationId: "org-2" });
    expect((await resend(id)).status).toBe(404);
  });
});

describe("revoke", () => {
  it("revokes, frees the seat and kills the link", async () => {
    const { id, token } = await invite("rep@example.test");
    const res = await revoke(id);
    expect(res.status).toBe(200);
    expect(invites()[0].revokedAt).toBeInstanceOf(Date);
    expect((await revoke(id)).status).toBe(404);

    as("newbie");
    const used = await accept(token);
    expect(used.status).toBe(404);
    expect(await used.json()).toMatchObject({ error: "invite_not_found" });
    expect(user("newbie").organizationId ?? null).toBeNull();
  });
});

describe("remove member", () => {
  it("removes a member from the team, keeping their account", async () => {
    const res = await remove("mgr-1");
    expect(res.status).toBe(200);
    expect(user("mgr-1")).toMatchObject({ organizationId: null, role: "trainee" });
    expect(fake.rows("auditEvent").some((e) => e.action === "team.member_removed" && e.resource === "mgr-1")).toBe(true);
  });

  it("refuses to remove yourself, and another team's member reads as not found", async () => {
    const self = await remove("owner-1");
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ error: "cannot_remove_self" });
    expect((await remove("free-owner")).status).toBe(404);
    expect(user("free-owner").organizationId).toBe("org-free");
  });
});

describe("accept", () => {
  it("joins with the invite's role when the email matches, case-insensitively, and only once", async () => {
    const { token } = await invite("REP@Example.test", "manager");
    fake.rows("user").find((u) => u.id === "newbie")!.email = "Rep@EXAMPLE.test";
    as("newbie");
    const p = await preview(token);
    expect(await p.json()).toMatchObject({ teamName: "Harbor Point", role: "manager", emailMatches: true, alreadyMember: false });

    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, team: { name: "Harbor Point" }, user: { id: "newbie", role: "manager" } });
    expect(res.headers.get("set-cookie")).toMatch(/^authToken=[^;]+;/);
    expect(user("newbie")).toMatchObject({ organizationId: "org-1", role: "manager" });
    expect(invites()[0]).toMatchObject({ acceptedById: "newbie" });

    const again = await accept(token);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: "invite_used" });
  });

  it("refuses an account with a different email (403)", async () => {
    const { token } = await invite("someone.else@example.test");
    as("newbie");
    const p = (await (await preview(token)).json()) as { emailMatches: boolean; invitedEmail: string };
    expect(p).toMatchObject({ emailMatches: false, invitedEmail: "s******@example.test" });
    const res = await accept(token);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "email_mismatch" });
    expect(user("newbie").organizationId ?? null).toBeNull();
  });

  it("refuses an expired invite (410)", async () => {
    const { token } = seedInvite("rep@example.test", { expiresAt: new Date(Date.now() - 1000) });
    as("newbie");
    const res = await accept(token);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "invite_expired" });
  });

  it("returns 409 seats_full when seats were reduced after the invite was sent", async () => {
    const { token } = await invite("rep@example.test");
    await invite("other@example.test");
    // Billing dropped the team to 3 seats: 2 members + 2 pending already passes it.
    fake.rows("organization").find((o) => o.id === "org-1")!.seatCount = 3;
    as("newbie");
    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "seats_full", message: "All 3 seats are in use. Add seats from Billing to invite more people.", seats: 3 });
    expect(invites()[0].acceptedAt).toBeNull();
  });

  it("accepts into the last free seat, since the invite already holds it", async () => {
    fake.rows("organization").find((o) => o.id === "org-1")!.seatCount = 3;
    const { token } = await invite("rep@example.test");
    as("newbie");
    expect((await accept(token)).status).toBe(200);
  });

  it("refuses the only owner of a team that still has members", async () => {
    fake.seed("organization", { id: "org-3", code: "404", name: "Third", planTier: "team", seatCount: 5 });
    const leaving = fake.rows("user").find((u) => u.id === "newbie")!;
    leaving.organizationId = "org-3";
    leaving.role = "owner";
    fake.seed("user", { id: "rep-3", email: "rep3@example.test", organizationId: "org-3", role: "trainee" });
    const { token } = await invite("rep@example.test");
    as("newbie");
    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "sole_owner" });
  });

  it("rejects a malformed token without touching the database", async () => {
    as("newbie");
    expect((await accept("short")).status).toBe(404);
  });
});

describe("sign-up from an invite", () => {
  const signup = (email: string, inviteToken: string) =>
    register(json("/api/auth/register", "POST", { firstName: "Ana", lastName: "Diaz", email, password: "correct-horse-battery", inviteToken }));

  it("creates the account without a team when the invite is open for that email", async () => {
    const { token } = await invite("ana@example.test");
    const res = await signup("Ana@Example.test", token);
    expect(res.status).toBe(200);
    const created = fake.rows("user").find((u) => u.email === "ana@example.test")!;
    expect(created).toMatchObject({ organizationId: null, role: "trainee" });
    expect(invites()[0].acceptedAt).toBeNull();
  });

  it("refuses a different email", async () => {
    const { token } = await invite("ana@example.test");
    const res = await signup("someone@example.test", token);
    expect(res.status).toBe(400);
    expect(fake.rows("user").some((u) => u.email === "someone@example.test")).toBe(false);
  });
});

describe("races: every check is repeated under the lock", () => {
  /**
   * Runs `run` the first time a FOR UPDATE on that row is taken, as if another request committed it while this one
   * waited for the lock. Anything the route read before the lock is stale from then on.
   */
  function whileWaitingFor(table: "Organization" | "User", id: string, run: () => void) {
    const original = fake.db.$queryRaw;
    let fired = false;
    fake.db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!fired && strings.join("?").includes(`FROM "${table}"`) && values[0] === id) { fired = true; run(); }
      return original(strings, ...values);
    };
  }
  const locked = () => fake.rawQueries.filter((q) => q.sql.includes("FOR UPDATE")).map((q) => `${q.sql.includes('"User"') ? "user" : "org"}:${q.values[0]}`);
  const demote = (id: string, patch: Record<string, unknown>) => () => Object.assign(user(id), patch);

  afterEach(() => vi.useRealTimers());

  it("two owners removing each other: the one who waited finds they were removed and gets 403", async () => {
    fake.seed("user", { id: "owner-2", email: "owner2@harborpoint.example", organizationId: "org-1", role: "owner" });
    as("owner-2");
    // owner-1 removed owner-2 while owner-2's request waited for the lock.
    whileWaitingFor("Organization", "org-1", demote("owner-2", { organizationId: null, role: "trainee" }));
    const res = await remove("owner-1");
    expect(res.status).toBe(403);
    expect(user("owner-1")).toMatchObject({ organizationId: "org-1", role: "owner" });
  });

  it("an owner may still remove another owner when nothing changed meanwhile", async () => {
    fake.seed("user", { id: "owner-2", email: "owner2@harborpoint.example", organizationId: "org-1", role: "owner" });
    as("owner-2");
    expect((await remove("owner-1")).status).toBe(200);
  });

  it.each([
    ["create", () => create(["x@example.test"])],
    ["resend", () => resend(invites()[0].id)],
    ["revoke", () => revoke(invites()[0].id)],
    ["remove", () => remove("mgr-1")],
  ])("%s: an owner demoted while waiting for the lock gets 403 and changes nothing", async (_name, run) => {
    seedInvite("rep@example.test", { expiresAt: new Date(Date.now() + DAY) });
    const snapshot = JSON.stringify([fake.rows("teamInvite"), user("mgr-1")]);
    whileWaitingFor("Organization", "org-1", demote("owner-1", { role: "manager" }));
    const res = await run();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(JSON.stringify([fake.rows("teamInvite"), user("mgr-1")])).toBe(snapshot);
  });

  it("create: a plan dropped from Team while waiting gets 403 team_plan_required", async () => {
    whileWaitingFor("Organization", "org-1", () => { fake.rows("organization").find((o) => o.id === "org-1")!.planTier = "free"; });
    const res = await create(["x@example.test"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "team_plan_required" });
    expect(invites()).toHaveLength(0);
  });

  describe("accept", () => {
    /** newbie and co-owner own org-3, which also has a rep. */
    function twoOwnerTeam() {
      fake.seed("organization", { id: "org-3", code: "404", name: "Third", planTier: "team", seatCount: 5 });
      Object.assign(user("newbie"), { organizationId: "org-3", role: "owner" });
      fake.seed("user", { id: "co-owner", email: "co@third.example", organizationId: "org-3", role: "owner" });
      fake.seed("user", { id: "rep-3", email: "rep3@third.example", organizationId: "org-3", role: "trainee" });
    }

    it("locks the team being left and the team being joined, in id order, then the user", async () => {
      twoOwnerTeam();
      const { token } = await invite("rep@example.test");
      fake.rawQueries.length = 0;
      as("newbie");
      expect((await accept(token)).status).toBe(200);
      expect(locked()).toEqual(["org:org-1", "org:org-3", "user:newbie"]);
    });

    it("two owners of one team leaving at once: the second sees the first gone and gets 409 sole_owner", async () => {
      twoOwnerTeam();
      const { token } = await invite("rep@example.test");
      as("newbie");
      // co-owner accepted an invite elsewhere while newbie waited on org-3's lock.
      whileWaitingFor("Organization", "org-3", demote("co-owner", { organizationId: "org-free", role: "trainee" }));
      const res = await accept(token);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "sole_owner" });
      expect(user("newbie")).toMatchObject({ organizationId: "org-3", role: "owner" });
      expect(invites()[0].acceptedAt).toBeNull();
    });

    it("an account that changed teams before the locks gets 409 conflict, not a join from an unlocked team", async () => {
      const { token } = await invite("rep@example.test");
      as("newbie");
      whileWaitingFor("Organization", "org-1", demote("newbie", { organizationId: "org-free" }));
      const res = await accept(token);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "conflict" });
      expect(invites()[0].acceptedAt).toBeNull();
    });

    it("an invite that expires while the request waits for the lock is refused (410)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
      const { token } = seedInvite("rep@example.test", { expiresAt: new Date("2026-11-04T12:00:30Z") });
      as("newbie");
      whileWaitingFor("Organization", "org-1", () => vi.setSystemTime(new Date("2026-11-04T12:01:00Z")));
      const res = await accept(token);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ error: "invite_expired" });
      expect(invites()[0].acceptedAt).toBeNull();
      expect(user("newbie").organizationId ?? null).toBeNull();
    });

    it("the claim itself requires the invite to be unexpired", async () => {
      const { token } = seedInvite("rep@example.test", { expiresAt: new Date(Date.now() + DAY) });
      as("newbie");
      // The row's expiry lands in the past between the checks and the claim.
      fake.interleave("teamInvite", "updateMany", async () => { fake.rows("teamInvite")[0].expiresAt = new Date(Date.now() - 1000); });
      const res = await accept(token);
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ error: "invite_expired" });
      expect(invites()[0].acceptedAt).toBeNull();
      expect(user("newbie").organizationId ?? null).toBeNull();
    });
  });
});

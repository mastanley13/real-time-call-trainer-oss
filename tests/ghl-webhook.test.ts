import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database, auth and seal check are the only fakes; the emitter and the routes run for real against a stubbed fetch.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    trainerSession: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock("@/lib/apiAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiAuth")>()),
  requireAuth: () => ({ id: "u-1", email: "u-1@example.test", role: "owner" }),
  isDemoUser: () => false,
}));
vi.mock("@/lib/gradeSeal", () => ({ verifySeal: () => true }));

import {
  GHL_TIMEOUT_MS,
  emitGhlEvent,
  firstGradedCallPayload,
  ghlBillingSink,
  ghlEventsEnabled,
  notifyIfFirstGradedCall,
  notifySignup,
  planChangePayload,
  postGhlEvent,
  settleGhlEvents,
  signGhlBody,
  signupPayload,
} from "@/lib/ghlWebhook";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";

const URL_ = "https://hooks.example.test/hooks/loc-test/webhook-trigger/trigger-test";
const SECRET = "test-only-ghl-secret";
const NOW = new Date("2026-11-05T12:00:00Z");

let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, init: init as RequestInit, body: JSON.parse((init as RequestInit).body as string) }));
const on = () => {
  vi.stubEnv("GHL_BILLING_EVENTS", "true");
  vi.stubEnv("GHL_WEBHOOK_URL", URL_);
};

beforeEach(() => {
  vi.stubEnv("GHL_BILLING_EVENTS", "");
  vi.stubEnv("GHL_WEBHOOK_URL", "");
  vi.stubEnv("GHL_WEBHOOK_SECRET", "");
  vi.stubEnv("JWT_SECRET", "test-only-secret-0123456789abcdef");
  vi.stubEnv("TRAINER_ACCESS_CODE", "");
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  for (const group of Object.values(mocks.prisma)) {
    if (typeof group === "function") group.mockReset();
    else for (const fn of Object.values(group)) fn.mockReset();
  }
});

afterEach(async () => {
  await settleGhlEvents();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signupInput = { userId: "u-1", organizationId: "org-1", email: "Mia@Example.test", method: "email" as const, role: "owner" as const, intent: { plan: "pro" as const, interval: "year" as const, src: "pricing", seg: "hvac" } };
const planEvent = { kind: "upgrade" as const, subject: "user" as const, subjectId: "u-1", fromPlan: "free" as const, toPlan: "pro" as const, seats: 1, premiumVoice: false, stripeRef: "evt_test_1", purchaserUserId: "u-1" };

describe("off by default", () => {
  it("sends nothing when the flag is off, the URL is unset, or the URL is not https", async () => {
    notifySignup(signupInput);
    vi.stubEnv("GHL_BILLING_EVENTS", "true");
    expect(ghlEventsEnabled()).toBe(false);
    notifySignup(signupInput);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GHL_WEBHOOK_URL", "http://hooks.example.test/plain");
    expect(ghlEventsEnabled()).toBe(false);
    notifySignup(signupInput);
    vi.stubEnv("GHL_BILLING_EVENTS", "false");
    vi.stubEnv("GHL_WEBHOOK_URL", URL_);
    expect(ghlEventsEnabled()).toBe(false);
    notifySignup(signupInput);
    ghlBillingSink(planEvent);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("payloads", () => {
  it("signup: deterministic id, lowercased email, intent tags, nothing else personal", () => {
    expect(signupPayload(signupInput, NOW)).toEqual({
      eventId: "signup:u-1", event: "signup", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      userId: "u-1", organizationId: "org-1", email: "mia@example.test", signupMethod: "email", role: "owner",
      planIntent: "pro", billingInterval: "year", source: "pricing", segment: "hvac",
    });
  });

  it("first_graded_call: keyed on the user, with the lowercased email", () => {
    const p = firstGradedCallPayload({ userId: "u-1", organizationId: "org-1", email: "Mia@Example.test", sessionId: "s-1", scenarioId: "quote-follow-up", overallScore: 71.6, grade: "B" }, NOW);
    expect(p).toEqual({
      eventId: "first_graded_call:u-1", event: "first_graded_call", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      userId: "u-1", organizationId: "org-1", email: "mia@example.test", sessionId: "s-1", scenarioId: "quote-follow-up", overallScore: 72, grade: "B",
    });
  });

  it("plan change: keyed on the Stripe reference and kind; a Team plan names the org and the buyer", () => {
    expect(planChangePayload(planEvent, "Mia@Example.test", NOW)).toEqual({
      eventId: "stripe:evt_test_1:upgrade", event: "upgrade", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      subject: "user", subjectId: "u-1", userId: "u-1", organizationId: null, email: "mia@example.test",
      fromPlan: "free", toPlan: "pro", seats: 1, premiumVoice: false, stripeRef: "evt_test_1",
    });
    const team = planChangePayload({ ...planEvent, kind: "churn", subject: "organization", subjectId: "org-1", fromPlan: "team", toPlan: "free", seats: 1, purchaserUserId: "u-9" }, null, NOW);
    expect(team).toMatchObject({ eventId: "stripe:evt_test_1:churn", subject: "organization", userId: "u-9", organizationId: "org-1", email: null });
  });
});

describe("plan change email", () => {
  const orgEvent = { ...planEvent, subject: "organization" as const, subjectId: "org-1", toPlan: "team" as const, seats: 5, purchaserUserId: null };
  const sinkBody = async (event: Parameters<typeof ghlBillingSink>[0]) => {
    on();
    ghlBillingSink(event);
    await settleGhlEvents();
    return sent().map((c) => c.body);
  };

  it("a Pro plan uses the user's email", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ email: "Mia@Example.test" });
    expect(await sinkBody(planEvent)).toEqual([expect.objectContaining({ event: "upgrade", userId: "u-1", email: "mia@example.test" })]);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "u-1" }, select: { email: true, organizationId: true } });
    expect(mocks.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("a Team plan uses the buyer's email while the buyer is still in the org", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({ email: "buyer@example.test", organizationId: "org-1" });
    expect(await sinkBody({ ...orgEvent, purchaserUserId: "u-9" })).toEqual([expect.objectContaining({ userId: "u-9", organizationId: "org-1", email: "buyer@example.test" })]);
    expect(mocks.prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("a buyer who left the org (no org, or another org) falls back to the org owner", async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ email: "owner@example.test" }]);
    for (const organizationId of [null, "org-other"]) {
      fetchMock.mockClear();
      mocks.prisma.user.findUnique.mockResolvedValue({ email: "buyer@example.test", organizationId });
      expect(await sinkBody({ ...orgEvent, purchaserUserId: "u-9" })).toEqual([expect.objectContaining({ userId: "u-9", email: "owner@example.test" })]);
    }
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", role: "owner" } }));
  });

  it("a Team plan with no buyer resolves the org owner's email", async () => {
    mocks.prisma.user.findMany.mockResolvedValue([{ email: "Owner@Example.test" }]);
    expect(await sinkBody(orgEvent)).toEqual([expect.objectContaining({ subject: "organization", userId: null, email: "owner@example.test" })]);
    expect(mocks.prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", role: "owner" }, take: 1, select: { email: true } }));
  });

  it("a deleted buyer falls back to the org owner", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    mocks.prisma.user.findMany.mockResolvedValue([{ email: "owner@example.test" }]);
    expect(await sinkBody({ ...orgEvent, purchaserUserId: "u-gone" })).toEqual([expect.objectContaining({ email: "owner@example.test" })]);
  });

  it("an org with no owner row still sends, with email null", async () => {
    mocks.prisma.user.findMany.mockResolvedValue([]);
    expect(await sinkBody(orgEvent)).toEqual([expect.objectContaining({ event: "upgrade", email: null })]);
  });

  it("a failed lookup still sends, with email null", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.user.findMany.mockRejectedValue(new Error("db down"));
    expect(await sinkBody(orgEvent)).toEqual([expect.objectContaining({ event: "upgrade", email: null })]);
    expect(errors.mock.calls.map((c) => c.join(" "))).toEqual(["[ghl] upgrade contact email lookup failed; sending without email"]);
  });

  it("a hung lookup is abandoned at the timeout and the event still sends, with email null", async () => {
    vi.useFakeTimers();
    try {
      on();
      mocks.prisma.user.findMany.mockReturnValue(new Promise(() => {}));
      ghlBillingSink(orgEvent);
      await vi.advanceTimersByTimeAsync(GHL_TIMEOUT_MS + 1);
    } finally {
      vi.useRealTimers();
    }
    await settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([expect.objectContaining({ email: null })]);
  });

  it("the sink returns before the lookup finishes", async () => {
    on();
    let release!: (v: { email: string }) => void;
    mocks.prisma.user.findUnique.mockReturnValue(new Promise((r) => { release = r; }));
    expect(ghlBillingSink(planEvent)).toBeUndefined();
    await vi.waitFor(() => expect(mocks.prisma.user.findUnique).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    release({ email: "mia@example.test" });
    await settleGhlEvents();
    expect(sent().map((c) => c.body.email)).toEqual(["mia@example.test"]);
  });
});

describe("sending", () => {
  it("posts JSON with an Idempotency-Key and no signature when GHL_WEBHOOK_SECRET is unset", async () => {
    on();
    notifySignup(signupInput);
    await settleGhlEvents();
    const [call] = sent();
    expect(call.url).toBe(URL_);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["idempotency-key"]).toBe("signup:u-1");
    expect(headers["x-calltrainer-signature"]).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.redirect).toBe("error");
    expect(call.body.event).toBe("signup");
  });

  it("signs the body when GHL_WEBHOOK_SECRET is set, and the secret is never in the body", async () => {
    on();
    vi.stubEnv("GHL_WEBHOOK_SECRET", SECRET);
    ghlBillingSink(planEvent);
    await settleGhlEvents();
    const [call] = sent();
    const headers = call.init.headers as Record<string, string>;
    const ts = headers["x-calltrainer-timestamp"];
    expect(ts).toMatch(/^\d+$/);
    expect(headers["x-calltrainer-signature"]).toBe(signGhlBody(SECRET, ts, call.init.body as string));
    expect(call.init.body as string).not.toContain(SECRET);
    expect(call.init.body as string).not.toContain(URL_);
    expect(call.body.eventId).toBe("stripe:evt_test_1:upgrade");
  });

  it("swallows a timeout, a network error and a non-2xx answer, and logs without the URL or secret", async () => {
    on();
    vi.stubEnv("GHL_WEBHOOK_SECRET", SECRET);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(new Response("gateway says no", { status: 502 }));
    await expect(postGhlEvent(signupPayload(signupInput))).resolves.toBeUndefined();
    await expect(postGhlEvent(signupPayload(signupInput))).resolves.toBeUndefined();
    await expect(postGhlEvent(signupPayload(signupInput))).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => c.join(" "));
    expect(logged).toEqual(["[ghl] signup webhook timed out", "[ghl] signup webhook failed", "[ghl] signup webhook answered status 502"]);
    expect(logged.join(" ")).not.toContain(URL_);
    expect(logged.join(" ")).not.toContain(SECRET);
    expect(logged.join(" ")).not.toContain("gateway says no");
  });

  it("aborts a hung request at the hard timeout", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Stand in for the timer so the test does not wait GHL_TIMEOUT_MS: the emitter's signal is one we can fire.
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    }));
    const done = postGhlEvent(signupPayload(signupInput));
    expect(GHL_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenCalledWith(GHL_TIMEOUT_MS);
    clock.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it("emitGhlEvent returns before the POST finishes and a failing builder is swallowed", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = () => r(new Response("ok")); }));
    expect(emitGhlEvent(signupPayload(signupInput))).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    release();
    emitGhlEvent(async () => { throw new Error("db down"); });
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("first graded call", () => {
  const input = { userId: "u-1", organizationId: "org-1", email: "u-1@example.test", sessionId: "s-2", scenarioId: "quote-follow-up", overallScore: 80, grade: "B" as const };

  it("sends only when the saved call is the user's earliest graded call", async () => {
    on();
    const earliest = vi.fn(async () => "s-1");
    notifyIfFirstGradedCall(input, earliest);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    notifyIfFirstGradedCall({ ...input, sessionId: "s-1" }, earliest);
    await settleGhlEvents();
    expect(sent().map((c) => c.body.eventId)).toEqual(["first_graded_call:u-1"]);
  });

  it("does not read the database when events are off", async () => {
    const earliest = vi.fn(async () => "s-2");
    notifyIfFirstGradedCall(input, earliest);
    await settleGhlEvents();
    expect(earliest).not.toHaveBeenCalled();
  });
});

// ---- Routes --------------------------------------------------------------------------------------

const json = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("POST /api/auth/register", () => {
  const body = { firstName: "Mia", lastName: "Chen", email: "Mia@Example.test", password: "correct-horse-battery", newOrgName: "Example Team", src: "pricing", plan: "team" };
  const created = { id: "u-new", email: "mia@example.test", firstName: "Mia", lastName: "Chen", role: "owner", organizationId: "org-new", isPlatformAdmin: false };

  beforeEach(() => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    mocks.prisma.$transaction.mockResolvedValue({ user: created, organization: { id: "org-new", name: "Example Team", code: "1234" } });
  });

  it("sends signup after the account commits, without the password or phone", async () => {
    on();
    const res = await register(json("http://localhost/api/auth/register", body));
    expect(res.status).toBe(200);
    await settleGhlEvents();
    const [call] = sent();
    expect(call.body).toMatchObject({ eventId: "signup:u-new", event: "signup", email: "mia@example.test", signupMethod: "email", role: "owner", organizationId: "org-new", planIntent: "team", source: "pricing" });
    expect(call.init.body as string).not.toContain("correct-horse-battery");
    expect(Object.keys(call.body).sort()).toEqual(["app", "billingInterval", "email", "event", "eventId", "occurredAt", "organizationId", "planIntent", "role", "segment", "signupMethod", "source", "userId", "version"]);
  });

  it("signup still succeeds when GHL is down", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await register(json("http://localhost/api/auth/register", body));
    expect(res.status).toBe(200);
    await settleGhlEvents();
  });

  it("sends nothing when the account was not created", async () => {
    on();
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "u-old" });
    expect((await register(json("http://localhost/api/auth/register", body))).status).toBe(409);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/transcripts", () => {
  const evaluation = { overallScore: 74, grade: "B", goalAchievement: { achieved: true } };
  const save = (extra: Record<string, unknown> = {}) =>
    saveTranscript(json("http://localhost/api/transcripts", { sessionId: "rt-1", transcript: [{ role: "user", text: "Hello" }], scenario: { id: "quote-follow-up" }, evaluation, seal: "x", ...extra }));

  beforeEach(() => {
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "u-1", organizationId: "org-1", email: "U-1@Example.test" });
    mocks.prisma.trainerSession.create.mockImplementation(async () => ({ id: `s-${mocks.prisma.trainerSession.create.mock.calls.length}` }));
    mocks.prisma.auditEvent.create.mockResolvedValue({});
  });

  it("sends first_graded_call for the first graded save only", async () => {
    on();
    mocks.prisma.trainerSession.findFirst.mockResolvedValue({ id: "s-1" });
    expect((await save()).status).toBe(200);
    expect((await save()).status).toBe(200);
    await settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", email: "u-1@example.test", sessionId: "s-1", overallScore: 74, grade: "B" })]);
    expect(mocks.prisma.trainerSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u-1", overallScore: { not: null } } }));
  });

  it("an ungraded save sends nothing and never queries", async () => {
    on();
    expect((await save({ evaluation: undefined, seal: undefined })).status).toBe(200);
    await settleGhlEvents();
    expect(mocks.prisma.trainerSession.findFirst).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the save succeeds when the check or GHL fails", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.trainerSession.findFirst.mockRejectedValue(new Error("db hiccup"));
    expect((await save()).status).toBe(200);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

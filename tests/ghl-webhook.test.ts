import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The database, auth, seal check and model call are the only fakes; the emitter and the routes run for real against a stubbed fetch.
const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    trainerSession: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    auditEvent: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  chat: vi.fn(),
  authUser: { id: "u-1", email: "u-1@example.test", role: "owner" },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/llm", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/llm")>()), chat: mocks.chat }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  rateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock("@/lib/apiAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiAuth")>()),
  requireAuth: () => mocks.authUser,
  isDemoUser: () => false,
}));
vi.mock("@/lib/gradeSeal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/gradeSeal")>()), verifySeal: () => true, sealEvaluation: () => "test-seal" }));

import {
  GHL_RETRY_DELAY_MS,
  GHL_TIMEOUT_MS,
  emitGhlEvent,
  firstGradedCallPayload,
  ghlBillingSink,
  ghlEventsEnabled,
  ghlTagsFor,
  notifyFirstGradedCall,
  notifySignup,
  planChangePayload,
  postGhlEvent,
  settleGhlEvents,
  signGhlBody,
  signupPayload,
  claimFirstGradedCall,
  FIRST_GRADED_MARKER,
  ghlPremiumSink,
  voiceCapHitPayload,
  voiceCapHitEventId,
  VOICE_CAP_HIT_LOCK_PREFIX,
  VOICE_CAP_HIT_MARKER,
} from "@/lib/ghlWebhook";
import type { PremiumEvent } from "@/lib/billingEvents";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { PATCH as regrade } from "@/app/api/transcripts/[id]/route";
import { POST as evaluateCallRoute } from "@/app/api/evaluate-call/route";
import { LIBRARY } from "@/lib/personas";

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
  mocks.chat.mockReset();
  mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "owner" };
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
const planEvent = { kind: "upgrade" as const, subject: "user" as const, subjectId: "u-1", fromPlan: "free" as const, toPlan: "pro" as const, seats: 1, premiumVoice: false, transition: "1767225600000", stripeRef: "evt_test_1", purchaserUserId: "u-1" };

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
      tags: ["ct-signed-up", "app-calltrainer", "ct-signup-email"],
      userId: "u-1", organizationId: "org-1", email: "mia@example.test", signupMethod: "email", role: "owner",
      planIntent: "pro", billingInterval: "year", source: "pricing", segment: "hvac",
    });
  });

  it("first_graded_call: keyed on the user, with the lowercased email", () => {
    const p = firstGradedCallPayload({ userId: "u-1", organizationId: "org-1", email: "Mia@Example.test", sessionId: "s-1", scenarioId: "quote-follow-up", overallScore: 71.6, grade: "B" }, NOW);
    expect(p).toEqual({
      eventId: "first_graded_call:u-1", event: "first_graded_call", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      tags: ["ct-activated", "app-calltrainer"],
      userId: "u-1", organizationId: "org-1", email: "mia@example.test", sessionId: "s-1", scenarioId: "quote-follow-up", overallScore: 72, grade: "B",
    });
  });

  it("plan change: keyed on the Stripe reference, kind and transition; a Team plan names the org and the buyer", () => {
    expect(planChangePayload(planEvent, "Mia@Example.test", NOW)).toEqual({
      eventId: "stripe:evt_test_1:upgrade:1767225600000", event: "upgrade", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      tags: ["ct-paid-pro", "app-calltrainer"],
      subject: "user", subjectId: "u-1", userId: "u-1", organizationId: null, email: "mia@example.test",
      fromPlan: "free", toPlan: "pro", seats: 1, premiumVoice: false, stripeRef: "evt_test_1",
    });
    const team = planChangePayload({ ...planEvent, kind: "churn", subject: "organization", subjectId: "org-1", fromPlan: "team", toPlan: "free", seats: 1, purchaserUserId: "u-9" }, null, NOW);
    expect(team).toMatchObject({ eventId: "stripe:evt_test_1:churn:1767225600000", subject: "organization", userId: "u-9", organizationId: "org-1", email: null, tags: ["ct-churned", "app-calltrainer"] });
  });
});

describe("tags (ghlTagsFor)", () => {
  it("signup by method", () => {
    expect(ghlTagsFor({ event: "signup", signupMethod: "email" })).toEqual(["ct-signed-up", "app-calltrainer", "ct-signup-email"]);
    expect(ghlTagsFor({ event: "signup", signupMethod: "google" })).toEqual(["ct-signed-up", "app-calltrainer", "ct-signup-google"]);
    expect(signupPayload({ ...signupInput, method: "google" }, NOW).tags).toEqual(["ct-signed-up", "app-calltrainer", "ct-signup-google"]);
  });

  it("first_graded_call is activation", () => {
    expect(ghlTagsFor({ event: "first_graded_call" })).toEqual(["ct-activated", "app-calltrainer"]);
  });

  it.each([
    ["upgrade", "free", "pro", "ct-paid-pro"],
    ["upgrade", "free", "team", "ct-paid-team"],
    ["upgrade", "pro", "team", "ct-paid-team"],
    ["downgrade", "team", "pro", "ct-paid-pro"],
    ["churn", "pro", "free", "ct-churned"],
    ["churn", "team", "free", "ct-churned"],
  ] as const)("%s %s to %s gets %s", (kind, fromPlan, toPlan, tag) => {
    expect(ghlTagsFor({ event: kind, toPlan })).toEqual([tag, "app-calltrainer"]);
    expect(planChangePayload({ ...planEvent, kind, fromPlan, toPlan }, null, NOW).tags).toEqual([tag, "app-calltrainer"]);
  });

  it("never emits a trial tag, and every event carries app-calltrainer", () => {
    const all = [
      ghlTagsFor({ event: "signup", signupMethod: "email" }),
      ghlTagsFor({ event: "signup", signupMethod: "google" }),
      ghlTagsFor({ event: "first_graded_call" }),
      ...(["upgrade", "downgrade", "churn"] as const).flatMap((event) => (["free", "pro", "team"] as const).map((toPlan) => ghlTagsFor({ event, toPlan }))),
    ];
    for (const tags of all) {
      expect(tags).toContain("app-calltrainer");
      for (const t of tags) expect(t).not.toMatch(/trial/i);
    }
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
    expect(call.body.eventId).toBe("stripe:evt_test_1:upgrade:1767225600000");
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

/**
 * A small in-memory database for the first graded call: sessions, users and audit rows. Records the order of the calls
 * that matter (create, update, lock, marker check, session lookup, audit inserts). It cannot block, so the advisory lock
 * is recorded, not enforced; tests run one claim at a time.
 */
type SessionRow = { id: string; userId: string; organizationId: string; scenarioId: string; transcript: unknown; evaluation: unknown; overallScore: number | null; grade: string | null; createdAt: Date; updatedAt: Date };
const T0 = Date.parse("2026-01-01T00:00:00Z");
function gradeStore() {
  const rows: SessionRow[] = [];
  const audits: { userId: string | null; action: string; resource?: string | null; metadata?: unknown }[] = [];
  const order: string[] = [];
  const users: Record<string, { id: string; email: string; organizationId: string; role: string; isPlatformAdmin: boolean }> = {
    "u-1": { id: "u-1", email: "U-1@Example.test", organizationId: "org-1", role: "trainee", isPlatformAdmin: false },
    "m-1": { id: "m-1", email: "m-1@example.test", organizationId: "org-1", role: "manager", isPlatformAdmin: false },
  };
  let clock = T0;
  const seed = (id: string, userId: string, graded?: { score: number; grade?: string }) => {
    const r: SessionRow = {
      id, userId, organizationId: "org-1", scenarioId: LIBRARY[0].id, transcript: [{ role: "user", text: "Hello there, how can I help?" }, { role: "assistant", text: "I need a quote." }],
      evaluation: graded ? { method: "heuristic", overallScore: graded.score, grade: graded.grade ?? "C" } : null,
      overallScore: graded?.score ?? null, grade: graded ? (graded.grade ?? "C") : null, createdAt: new Date(clock += 1000), updatedAt: new Date(T0),
    };
    rows.push(r);
    return r;
  };
  mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => users[where.id] ?? null);
  mocks.prisma.trainerSession.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const r = rows.find((x) => x.id === where.id);
    return r ? { ...r } : null;
  });
  mocks.prisma.trainerSession.create.mockImplementation(async ({ data }: { data: Partial<SessionRow> & { userId: string } }) => {
    order.push("create");
    const r = { ...data, id: `s-${mocks.prisma.trainerSession.create.mock.calls.length}`, organizationId: "org-1", createdAt: new Date(clock += 1000), updatedAt: new Date() } as SessionRow;
    rows.push(r);
    return { id: r.id };
  });
  mocks.prisma.trainerSession.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<SessionRow> }) => {
    order.push("update");
    const r = rows.find((x) => x.id === where.id)!;
    Object.assign(r, data, { updatedAt: new Date() });
    return { ...r };
  });
  mocks.prisma.trainerSession.findFirst.mockImplementation(async ({ where }: { where: { userId: string; realtimeSessionId?: string; id?: unknown } }) => {
    if (where.realtimeSessionId !== undefined || where.id !== undefined) {
      // The call-row checks (src/lib/callRow.ts). Rows here name no call, so none matches.
      order.push("call-check");
      return null;
    }
    order.push("first-session");
    const r = rows.filter((x) => x.userId === where.userId && x.overallScore !== null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
    return r ? { id: r.id, organizationId: r.organizationId, scenarioId: r.scenarioId, overallScore: r.overallScore, grade: r.grade, user: { email: users[r.userId]?.email ?? null } } : null;
  });
  // The graded-duplicate check (src/lib/transcriptGrade.ts): this user's other graded rows of the same org and persona.
  mocks.prisma.trainerSession.findMany.mockImplementation(async ({ where }: { where: { userId: string; organizationId: string; scenarioId: string; id: { not: string } } }) => {
    order.push("transcript-check");
    return rows.filter((x) => x.userId === where.userId && x.organizationId === where.organizationId && x.scenarioId === where.scenarioId && x.overallScore !== null && x.id !== where.id.not)
      .map((x) => ({ transcript: x.transcript }));
  });
  mocks.prisma.auditEvent.create.mockImplementation(async ({ data }: { data: (typeof audits)[number] }) => {
    order.push(`audit:${data.action}`);
    audits.push(data);
    return { id: `a-${audits.length}` };
  });
  mocks.prisma.auditEvent.findFirst.mockImplementation(async ({ where }: { where: { userId: string; action: string } }) => {
    order.push("marker-check");
    return audits.find((a) => a.userId === where.userId && a.action === where.action) ? { id: "a-marker" } : null;
  });
  mocks.prisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => { order.push(`lock:${strings.join("?")}:${values.join(",")}`); return []; });
  // An interactive transaction runs on the same store; the PATCH route's array form runs its operations in order.
  mocks.prisma.$transaction.mockImplementation(async (arg: ((tx: typeof mocks.prisma) => Promise<unknown>) | Promise<unknown>[]) =>
    typeof arg === "function" ? arg(mocks.prisma) : Promise.all(arg));
  const markers = () => audits.filter((a) => a.action === FIRST_GRADED_MARKER);
  const activations = () => sent().filter((c) => c.body.event === "first_graded_call").map((c) => c.body);
  return { rows, audits, order, seed, markers, activations };
}

describe("first graded call (claimFirstGradedCall)", () => {
  let db: ReturnType<typeof gradeStore>;
  beforeEach(() => { db = gradeStore(); });
  const LOCK = "lock:SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(?::text)):ct-first-grade:u-1";

  it("sends once, naming the earliest graded session, and writes the marker", async () => {
    on();
    db.seed("s-a", "u-1");
    db.seed("s-b", "u-1", { score: 81, grade: "B" });
    db.seed("s-c", "u-1", { score: 60 });
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(db.activations()).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", email: "u-1@example.test", sessionId: "s-b", overallScore: 81, grade: "B", organizationId: "org-1", tags: ["ct-activated", "app-calltrainer"] })]);
    expect(db.markers()).toEqual([expect.objectContaining({ userId: "u-1", action: "ghl.first_graded_call_sent", resource: "s-b", metadata: { eventId: "first_graded_call:u-1" } })]);
  });

  it("takes the lock before the marker check, and inserts the marker before anything is sent", async () => {
    on();
    db.seed("s-b", "u-1", { score: 81 });
    let sentBeforeMarker = false;
    fetchMock.mockImplementation(async () => { sentBeforeMarker = db.markers().length === 0; return new Response("ok"); });
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(db.order).toEqual([LOCK, "marker-check", "first-session", "audit:ghl.first_graded_call_sent"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBeforeMarker).toBe(false);
  });

  it("with the marker present: nothing is sent and nothing more is written", async () => {
    on();
    db.seed("s-b", "u-1", { score: 81 });
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    notifyFirstGradedCall("u-1");
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(db.activations()).toHaveLength(1);
    expect(db.markers()).toHaveLength(1);
    // The later claims each took the lock and stopped at the marker check.
    expect(db.order.filter((o) => o === LOCK)).toHaveLength(3);
    expect(db.order.filter((o) => o === "marker-check")).toHaveLength(3);
    expect(db.order.filter((o) => o === "first-session")).toHaveLength(1);
  });

  it("with GHL not configured: no marker, no lock, no send; once configured it still goes out", async () => {
    db.seed("s-b", "u-1", { score: 81 });
    notifyFirstGradedCall("u-1");
    expect(await claimFirstGradedCall("u-1")).toBeNull();
    await settleGhlEvents();
    expect(db.markers()).toEqual([]);
    expect(mocks.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    on();
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(db.activations().map((b) => b.sessionId)).toEqual(["s-b"]);
  });

  it("a user with no graded session gets no marker, so a later first grade still sends", async () => {
    on();
    db.seed("s-a", "u-1");
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(db.markers()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failure inside the claim is swallowed: no marker, no send, nothing thrown", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.seed("s-b", "u-1", { score: 81 });
    mocks.prisma.auditEvent.findFirst.mockRejectedValue(new Error("db down"));
    expect(() => notifyFirstGradedCall("u-1")).not.toThrow();
    await settleGhlEvents();
    expect(db.markers()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("first graded call retry (one retry of the same POST)", () => {
  const activation = () => firstGradedCallPayload({ userId: "u-1", organizationId: "org-1", email: "u-1@example.test", sessionId: "s-b", scenarioId: LIBRARY[0].id, overallScore: 81, grade: "B" }, NOW);
  /** fetch's TypeError for a connection that never opened: the request cannot have reached GHL. */
  const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }) });
  const status = (s: number) => new Response("ghl says something private", { status: s });
  /** Yields one macrotask, so every pending microtask (the mocked fetch, the body cancel) has run. */
  const tick = () => new Promise((r) => setImmediate(r));

  afterEach(() => { vi.useRealTimers(); });

  for (const [name, first] of [["a connection-phase network error", () => Promise.reject(refused())], ["HTTP 503", async () => status(503)]] as const) {
    it(`retries once after ${name}, after the fixed delay, with the same body and Idempotency-Key`, async () => {
      on();
      vi.stubEnv("GHL_WEBHOOK_SECRET", SECRET);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const timeout = vi.spyOn(AbortSignal, "timeout");
      fetchMock.mockImplementationOnce(first);
      const done = postGhlEvent(activation());
      await tick();
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(GHL_RETRY_DELAY_MS - 1);
      await tick();
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      await done;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [a, b] = sent();
      expect(b.body).toEqual(a.body);
      expect(b.init.body).toBe(a.init.body);
      expect(b.init.headers).toEqual(a.init.headers);
      expect((b.init.headers as Record<string, string>)["idempotency-key"]).toBe("first_graded_call:u-1");
      // Each attempt has its own hard timeout.
      expect(timeout.mock.calls).toEqual([[GHL_TIMEOUT_MS], [GHL_TIMEOUT_MS]]);
      expect(a.init.signal).not.toBe(b.init.signal);
      const logged = [...errors.mock.calls, ...info.mock.calls].map((c) => c.join(" "));
      expect(logged).toEqual([
        name === "HTTP 503" ? "[ghl] first_graded_call webhook answered status 503" : "[ghl] first_graded_call webhook failed",
        "[ghl] first_graded_call webhook retry delivered",
      ]);
      expect(logged.join(" ")).not.toContain(URL_);
      expect(logged.join(" ")).not.toContain(SECRET);
      expect(logged.join(" ")).not.toContain("private");
    });
  }

  it("retries on 429, 502 and 504 too", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (const s of [429, 502, 504]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(status(s));
      await postGhlEvent(activation());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("never retries a timeout, a 400, a 500, a 2xx or a network error after the connection opened", async () => {
    on();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: [string, () => Promise<Response>][] = [
      ["timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
      ["400", async () => status(400)],
      ["500", async () => status(500)],
      ["200", async () => new Response("ok", { status: 200 })],
      ["202", async () => new Response(null, { status: 202 })],
      ["reset after send", () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }))],
      ["no cause", () => Promise.reject(new TypeError("fetch failed"))],
      ["sync throw", () => { throw new Error("boom"); }],
    ];
    for (const [, impl] of cases) {
      fetchMock.mockClear();
      fetchMock.mockImplementationOnce(impl);
      await postGhlEvent(activation());
      expect(fetchMock).toHaveBeenCalledOnce();
    }
    expect(errors.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("retry"))).toEqual([]);
  });

  it("never retries a connect timeout (TypeError with cause code UND_ERR_CONNECT_TIMEOUT): exactly one POST", async () => {
    on();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }));
    await postGhlEvent(activation());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errors.mock.calls.map((c) => c.join(" "))).toEqual(["[ghl] first_graded_call webhook failed"]);
  });

  it("retries at most once: a second clear failure is logged and dropped", async () => {
    on();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(503));
    await postGhlEvent(activation());
    fetchMock.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());
    await postGhlEvent(activation());
    fetchMock.mockResolvedValueOnce(status(502)).mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await postGhlEvent(activation());
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(errors.mock.calls.map((c) => c.join(" "))).toEqual([
      "[ghl] first_graded_call webhook answered status 503",
      "[ghl] first_graded_call webhook retry answered status 503",
      "[ghl] first_graded_call webhook failed",
      "[ghl] first_graded_call webhook retry failed",
      "[ghl] first_graded_call webhook answered status 502",
      "[ghl] first_graded_call webhook retry timed out",
    ]);
  });

  it("signup, plan changes and voice_cap_hit keep one attempt on a 503 or a refused connection", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const capHit = voiceCapHitPayload({ userId: "u-1", organizationId: "org-1", email: "u-1@example.test", plan: "free", reason: "cap_reached" }, NOW);
    for (const payload of [signupPayload(signupInput), planChangePayload(planEvent, "u-1@example.test"), capHit]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(status(503));
      await postGhlEvent(payload);
      expect(fetchMock).toHaveBeenCalledOnce();
      fetchMock.mockClear();
      fetchMock.mockRejectedValueOnce(refused());
      await postGhlEvent(payload);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("end to end: the claim runs once and writes one marker; only the POST is repeated", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const db = gradeStore();
    db.seed("s-b", "u-1", { score: 81, grade: "B" });
    fetchMock.mockResolvedValueOnce(status(503));
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.activations()).toHaveLength(2);
    expect(new Set(db.activations().map((b) => JSON.stringify(b))).size).toBe(1);
    expect(db.markers()).toEqual([expect.objectContaining({ userId: "u-1", resource: "s-b", metadata: { eventId: "first_graded_call:u-1" } })]);
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledOnce();
    expect(db.order.filter((o) => o.startsWith("lock:"))).toHaveLength(1);
    // A later grade finds the marker and sends nothing, retry or not.
    notifyFirstGradedCall("u-1");
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.markers()).toHaveLength(1);
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
    expect(call.url).toBe(URL_);
    expect(call.body).toMatchObject({ eventId: "signup:u-new", event: "signup", email: "mia@example.test", signupMethod: "email", role: "owner", organizationId: "org-new", planIntent: "team", source: "pricing", tags: ["ct-signed-up", "app-calltrainer", "ct-signup-email"] });
    expect(call.init.body as string).not.toContain("correct-horse-battery");
    expect(call.init.body as string).not.toMatch(/password/i);
    expect(call.init.body as string).not.toMatch(/trial/i);
    expect(Object.keys(call.body).sort()).toEqual(["app", "billingInterval", "email", "event", "eventId", "occurredAt", "organizationId", "planIntent", "role", "segment", "signupMethod", "source", "tags", "userId", "version"]);
  });

  /** Status and body, minus the token (its iat can tick between runs), so outcomes can be compared. */
  const shape = async (res: Response) => {
    const { token, ...rest } = await res.json();
    return { status: res.status, token: typeof token, cookie: (res.headers.get("set-cookie") ?? "").includes("authToken="), ...rest };
  };

  it("with GHL off: succeeds and never calls fetch", async () => {
    const res = await register(json("http://localhost/api/auth/register", body));
    expect(res.status).toBe(200);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signup still succeeds when GHL is down", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await register(json("http://localhost/api/auth/register", body));
    expect(res.status).toBe(200);
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("signup still succeeds when fetch throws synchronously", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation(() => { throw new Error("boom"); });
    expect((await register(json("http://localhost/api/auth/register", body))).status).toBe(200);
    await settleGhlEvents();
  });

  it("signup responds at once while the GHL POST hangs, and the POST is cut off at the hard timeout", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Stand in for the timer so the test does not wait GHL_TIMEOUT_MS: the emitter's signal is one we can fire.
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    let settled = false;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => { settled = true; reject(new DOMException("timed out", "TimeoutError")); });
    }));
    const res = await Promise.race([
      register(json("http://localhost/api/auth/register", body)),
      // Generous for bcrypt on a slow runner; the real proof is that the POST is still pending when the response is back.
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(res).not.toBe("hung");
    expect((res as Response).status).toBe(200);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(timeout).toHaveBeenCalledWith(GHL_TIMEOUT_MS);
    clock.abort();
    await settleGhlEvents();
    expect(settled).toBe(true);
  });

  it("responds the same whether GHL is off, failing or succeeding", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off = await shape(await register(json("http://localhost/api/auth/register", body)));
    on();
    const ok = await shape(await register(json("http://localhost/api/auth/register", body)));
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const down = await shape(await register(json("http://localhost/api/auth/register", body)));
    await settleGhlEvents();
    expect(off).toMatchObject({ status: 200, token: "string", cookie: true });
    expect(ok).toEqual(off);
    expect(down).toEqual(off);
  }, 20_000);

  it("sends nothing when the account was not created", async () => {
    on();
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "u-old" });
    expect((await register(json("http://localhost/api/auth/register", body))).status).toBe(409);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Every path that stores a grade, against one small in-memory session table: POST /api/transcripts (a sealed grade, which
 * /api/evaluate-call produces) and PATCH /api/transcripts/[id] (the first AI grade of a saved call, or a re-grade).
 */
describe("first graded call from every grading path", () => {
  const scenario = LIBRARY[0];
  const transcript = [{ role: "user", text: "Hi, thanks for calling. What made you reach out today?" }, { role: "assistant", text: "I need a quote." }];
  let seq: number;
  let db: ReturnType<typeof gradeStore>;
  const llmReply = () => JSON.stringify({
    summary: "You kept the caller talking.",
    criteria: scenario.rubric.map((c) => ({ id: c.id, score: 72, rationale: "You made a solid attempt.", evidence: [] })),
    strengths: ["You stayed calm."], improvements: ["Offer a time slot."], goalStatus: "partial", goalExplanation: "You made progress but booked nothing.",
  });
  const patch = (id: string) => regrade(json(`http://localhost/api/transcripts/${id}`, {}), { params: Promise.resolve({ id }) });
  const save = (evaluation: Record<string, unknown> | undefined) =>
    saveTranscript(json("http://localhost/api/transcripts", { sessionId: `rt-${++seq}`, transcript, scenario: { id: scenario.id }, evaluation, seal: evaluation ? "x" : undefined }));
  const sealed = { overallScore: 74, grade: "B", goalAchievement: { achieved: true } };

  beforeEach(() => {
    seq = 0;
    db = gradeStore();
    vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
    mocks.chat.mockResolvedValue(llmReply());
  });
  const activations = () => db.activations();
  // First-graded-call claims only; the call's own-row lock (src/lib/callRow.ts) is not a claim.
  const claimed = () => mocks.prisma.$queryRaw.mock.calls.filter((c) => String(c[1]).startsWith("ct-first-grade:")).length;

  it("POST: the first graded save schedules the claim and sends ct-activated once; a second graded call does not", async () => {
    on();
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", email: "u-1@example.test", sessionId: "s-1", overallScore: 74, grade: "B", tags: ["ct-activated", "app-calltrainer"] })]);
    expect(db.markers()).toHaveLength(1);
  });

  it("POST saves exactly as before (one create with the grade, then the audit row) and schedules the claim after the create", async () => {
    on();
    expect((await save(sealed)).status).toBe(200);
    expect(mocks.prisma.trainerSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({ overallScore: 74, grade: "B", goalAchieved: true }) });
    expect(mocks.prisma.trainerSession.update).not.toHaveBeenCalled();
    await settleGhlEvents();
    // The create claims the call's own row under the call's lock (src/lib/callRow.ts), then the transcript's lock and its
    // graded-duplicate check (src/lib/transcriptGrade.ts); the first-graded-call claim takes its own lock after the create.
    const create = db.order.indexOf("create");
    expect(db.order.slice(0, create)).toEqual([
      expect.stringMatching(/ct-call-grade:\["u-1","rt-1"\]$/), "call-check",
      expect.stringMatching(/ct-transcript-grade:\["u-1","[0-9a-f]{64}"\]$/), "transcript-check",
    ]);
    expect(db.order.indexOf("audit:session.saved")).toBeGreaterThan(create);
    expect(db.order.findIndex((o) => o.includes("ct-first-grade:"))).toBeGreaterThan(create);
  });

  it("POST: an ungraded save (no grade, or a grade that failed) schedules nothing", async () => {
    on();
    expect((await save(undefined)).status).toBe(200);
    expect((await save({ error: "Failed to evaluate call" })).status).toBe(200);
    await settleGhlEvents();
    expect(claimed()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POST: when the audit insert fails after the graded create, the save answers 500 as before and the claim still runs", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.auditEvent.create.mockImplementation(async ({ data }: { data: { action: string } }) => {
      if (data.action === "session.saved") throw new Error("audit insert failed");
      db.audits.push(data as (typeof db.audits)[number]);
      return { id: "a-marker" };
    });
    expect((await save(sealed)).status).toBe(500);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", sessionId: "s-1" })]);
    expect(db.markers()).toHaveLength(1);
  });

  it("POST: the save succeeds while GHL is down", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rollout: a user graded before this shipped (no marker) gets one ct-activated on their next graded call, naming the earliest", async () => {
    on();
    db.seed("s-legacy", "u-1", { score: 55, grade: "D" });
    expect((await save(sealed)).status).toBe(200);
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", sessionId: "s-legacy", grade: "D", tags: ["ct-activated", "app-calltrainer"] })]);
  });

  it("evaluate-call then save: grading alone sends nothing, the save of its sealed grade sends once", async () => {
    on();
    const graded = await evaluateCallRoute(json("http://localhost/api/evaluate-call", { scenario, transcript }));
    expect(graded.status).toBe(200);
    const evaluation = await graded.json();
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await save(evaluation)).status).toBe(200);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ sessionId: "s-1", overallScore: evaluation.overallScore })]);
  });

  it("PATCH: a call going from no score to a score schedules the claim and sends ct-activated once", async () => {
    on();
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    expect((await patch("s-old")).status).toBe(200);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ eventId: "first_graded_call:u-1", userId: "u-1", email: "u-1@example.test", sessionId: "s-old", tags: ["ct-activated", "app-calltrainer"] })]);
    expect(db.markers()).toHaveLength(1);
  });

  it("PATCH saves the grade and its audit row in one transaction under the transcript's lock, then the claim in the background", async () => {
    on();
    mocks.authUser = { id: "m-1", email: "m-1@example.test", role: "manager" };
    db.seed("s-old", "u-1");
    expect((await patch("s-old")).status).toBe(200);
    expect(mocks.prisma.$transaction.mock.calls[0][0]).toBeTypeOf("function");
    await settleGhlEvents();
    // The duplicate check runs before the model call and again under the transcript's lock (src/lib/transcriptGrade.ts).
    expect(db.order.slice(0, 6)).toEqual([
      "transcript-check", expect.stringMatching(/ct-transcript-grade:/), "transcript-check",
      "update", "audit:session.regraded", expect.stringMatching(/ct-first-grade:/),
    ]);
  });

  it("PATCH of a call that already had a score keeps the array transaction and takes no transcript lock", async () => {
    on();
    mocks.authUser = { id: "m-1", email: "m-1@example.test", role: "manager" };
    db.seed("s-graded", "u-1", { score: 60 });
    expect((await patch("s-graded")).status).toBe(200);
    expect(mocks.prisma.$transaction.mock.calls[0][0]).toBeInstanceOf(Array);
    expect(db.order.slice(0, 2)).toEqual(["update", "audit:session.regraded"]);
  });

  it("PATCH by a manager: the activation names the trainee, not the manager", async () => {
    on();
    mocks.authUser = { id: "m-1", email: "m-1@example.test", role: "manager" };
    db.seed("s-old", "u-1");
    expect((await patch("s-old")).status).toBe(200);
    await settleGhlEvents();
    expect(activations()).toEqual([expect.objectContaining({ userId: "u-1", email: "u-1@example.test", sessionId: "s-old" })]);
  });

  it("PATCH: a re-grade of a call that already had a score schedules nothing", async () => {
    on();
    mocks.authUser = { id: "m-1", email: "m-1@example.test", role: "manager" };
    db.seed("s-graded", "u-1", { score: 60 });
    expect((await patch("s-graded")).status).toBe(200);
    await settleGhlEvents();
    expect(claimed()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCH: once the first graded call was announced, grading an older ungraded call sends nothing", async () => {
    on();
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect((await patch("s-old")).status).toBe(200);
    await settleGhlEvents();
    expect(activations().map((b) => b.sessionId)).toEqual(["s-1"]);
  });

  it("PATCH: a failed AI grade stores nothing and sends nothing", async () => {
    on();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    mocks.chat.mockRejectedValue(new Error("model down"));
    const res = await patch("s-old");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("llm_failed");
    await settleGhlEvents();
    expect(db.rows[0].overallScore).toBeNull();
    expect(claimed()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCH then POST: the re-graded call was first, so the later graded save sends nothing", async () => {
    on();
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    expect((await patch("s-old")).status).toBe(200);
    await settleGhlEvents();
    expect((await save(sealed)).status).toBe(200);
    await settleGhlEvents();
    expect(activations().map((b) => b.sessionId)).toEqual(["s-old"]);
  });

  it("PATCH: a failed save (the transaction throws) answers 500 as before and schedules nothing", async () => {
    on();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    mocks.prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    expect((await patch("s-old")).status).toBe(500);
    await settleGhlEvents();
    expect(claimed()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCH succeeds and writes no marker while GHL is off", async () => {
    mocks.authUser = { id: "u-1", email: "u-1@example.test", role: "trainee" };
    db.seed("s-old", "u-1");
    expect((await patch("s-old")).status).toBe(200);
    await settleGhlEvents();
    expect(db.markers()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voice_cap_hit", () => {
  const capHit = (reason: string, extra: Partial<PremiumEvent> = {}): PremiumEvent => ({ name: "voice_cap_hit", subject: "user", subjectId: "u-1", reason, ...extra });
  const noSub = { subscriptionStatus: null, stripeSubscriptionId: null, pastDueSince: null };
  const freeUser = { email: "Mia@Example.test", organizationId: "org-1", planTier: "free", ...noSub, organization: { planTier: "free", ...noSub } };

  // The claim's store: AuditEvent markers, and pg_advisory_xact_lock modelled per transaction (held until it ends), so two
  // claims that overlap really wait on each other the way Postgres makes them.
  const markers: { userId: string | null; action: string; resource: string; metadata: unknown }[] = [];
  const lockKeys: string[] = [];
  const tick = () => new Promise<void>((r) => setImmediate(r));
  beforeEach(() => {
    markers.length = 0;
    lockKeys.length = 0;
    const locks = new Map<string, Promise<void>>();
    mocks.prisma.auditEvent.findFirst.mockImplementation(async ({ where }: { where: { action: string; resource: string } }) => {
      await tick();
      return markers.find((m) => m.action === where.action && m.resource === where.resource) ? { id: "a-marker" } : null;
    });
    mocks.prisma.auditEvent.create.mockImplementation(async ({ data }: { data: (typeof markers)[number] }) => {
      await tick();
      markers.push(data);
      return { id: `a-${markers.length}` };
    });
    mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const held: (() => void)[] = [];
      const tx = {
        ...mocks.prisma,
        $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          const key = String(values[0]);
          lockKeys.push(key);
          const before = locks.get(key) ?? Promise.resolve();
          let release!: () => void;
          const mine = new Promise<void>((r) => { release = r; });
          locks.set(key, before.then(() => mine));
          await before;
          held.push(release);
          return [];
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const r of held) r();
      }
    });
  });
  const users: Record<string, typeof freeUser> = {
    "u-1": freeUser,
    "u-2": { ...freeUser, email: "kai@example.test" },
    "u-3": { ...freeUser, email: "lee@example.test", organizationId: "org-2" },
    "u-solo": { ...freeUser, email: "solo@example.test", organizationId: null as unknown as string, organization: null as unknown as typeof freeUser.organization },
  };
  const byId = () => mocks.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => users[where.id] ?? null);

  it("payload: base fields, user and org ids, lowercased email, plan and reason, app tag only, nothing else", () => {
    expect(voiceCapHitPayload({ userId: "u-1", organizationId: "org-1", email: "Mia@Example.test", plan: "free", reason: "cap_reached" }, NOW)).toEqual({
      eventId: "voice_cap_hit:org-1:2026-11-05", event: "voice_cap_hit", occurredAt: "2026-11-05T12:00:00.000Z", app: "calltrainer", version: 1,
      tags: ["app-calltrainer"],
      userId: "u-1", organizationId: "org-1", email: "mia@example.test", plan: "free", reason: "cap_reached",
    });
    const unknown = voiceCapHitPayload({ userId: "u-1", organizationId: null, email: null, plan: null, reason: "cap_reached_in_call" }, NOW);
    expect(unknown).toMatchObject({ eventId: "voice_cap_hit:user:u-1:2026-11-05", email: null, plan: null, organizationId: null, reason: "cap_reached_in_call" });
  });

  it("eventId: one key per organization and UTC day, whatever the reason or member; the user only without an organization", () => {
    const at = new Date("2026-11-05T23:59:59.999Z");
    expect(voiceCapHitEventId({ userId: "u-1", organizationId: "org-1" }, at)).toBe("voice_cap_hit:org-1:2026-11-05");
    expect(voiceCapHitEventId({ userId: "u-2", organizationId: "org-1" }, at)).toBe("voice_cap_hit:org-1:2026-11-05");
    expect(voiceCapHitEventId({ userId: "u-1", organizationId: "org-1" }, new Date("2026-11-06T00:00:00Z"))).toBe("voice_cap_hit:org-1:2026-11-06");
    expect(voiceCapHitEventId({ userId: "u-3", organizationId: "org-2" }, at)).toBe("voice_cap_hit:org-2:2026-11-05");
    expect(voiceCapHitEventId({ userId: "u-1", organizationId: null }, at)).toBe("voice_cap_hit:user:u-1:2026-11-05");
  });

  it("same org, same UTC day: cap_reached then cap_reached_in_call sends one event, and the marker holds the claim", async () => {
    on();
    byId();
    ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-05T09:00:00.000Z" }));
    await settleGhlEvents();
    ghlPremiumSink(capHit("cap_reached_in_call", { occurredAt: "2026-11-05T15:00:00.000Z" }));
    await settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([expect.objectContaining({ eventId: "voice_cap_hit:org-1:2026-11-05", reason: "cap_reached", userId: "u-1" })]);
    expect(sent()[0].init.headers).toMatchObject({ "idempotency-key": "voice_cap_hit:org-1:2026-11-05" });
    expect(markers).toEqual([{ userId: "u-1", action: VOICE_CAP_HIT_MARKER, resource: "voice_cap_hit:org-1:2026-11-05", metadata: { eventId: "voice_cap_hit:org-1:2026-11-05", reason: "cap_reached" } }]);
    expect(lockKeys).toEqual([`${VOICE_CAP_HIT_LOCK_PREFIX}voice_cap_hit:org-1:2026-11-05`, `${VOICE_CAP_HIT_LOCK_PREFIX}voice_cap_hit:org-1:2026-11-05`]);
  });

  it("two users of one team org on the same UTC day send one event, even when both claims overlap", async () => {
    on();
    byId();
    // Fired together: both claims are in flight at once, and the advisory lock makes the second see the first's marker.
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-1", occurredAt: "2026-11-05T10:00:00.000Z" }));
    ghlPremiumSink(capHit("cap_reached_in_call", { subjectId: "u-2", occurredAt: "2026-11-05T10:00:01.000Z" }));
    await settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([expect.objectContaining({ eventId: "voice_cap_hit:org-1:2026-11-05", userId: "u-1" })]);
    expect(markers).toHaveLength(1);
    // A later member that day is dropped too.
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-2", occurredAt: "2026-11-05T22:00:00.000Z" }));
    await settleGhlEvents();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the next UTC day sends a new event, and different orgs send separately", async () => {
    on();
    byId();
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-1", occurredAt: "2026-11-05T23:59:59.000Z" }));
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-3", occurredAt: "2026-11-05T23:59:59.500Z" }));
    await settleGhlEvents();
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-1", occurredAt: "2026-11-06T00:00:00.000Z" }));
    await settleGhlEvents();
    ghlPremiumSink(capHit("cap_reached", { subjectId: "u-solo", occurredAt: "2026-11-06T00:00:01.000Z" }));
    await settleGhlEvents();
    expect(sent().map((c) => c.body.eventId).sort()).toEqual([
      "voice_cap_hit:org-1:2026-11-05",
      "voice_cap_hit:org-1:2026-11-06",
      "voice_cap_hit:org-2:2026-11-05",
      "voice_cap_hit:user:u-solo:2026-11-06",
    ]);
    expect(markers.map((m) => m.resource).sort()).toEqual(sent().map((c) => c.body.eventId).sort());
  });

  it("a failed claim sends nothing and logs only that", async () => {
    on();
    byId();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.auditEvent.findFirst.mockRejectedValueOnce(new Error("db down"));
    ghlPremiumSink(capHit("cap_reached"));
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markers).toEqual([]);
    expect(errors.mock.calls.map((c) => c.join(" "))).toEqual(["[ghl] voice_cap_hit claim failed; not sent"]);
  });

  it("adds no tag: only app-calltrainer, and no tag string the other events do not already use", () => {
    expect(ghlTagsFor({ event: "voice_cap_hit" })).toEqual(["app-calltrainer"]);
    const existing = new Set([
      ...ghlTagsFor({ event: "signup", signupMethod: "email" }),
      ...ghlTagsFor({ event: "signup", signupMethod: "google" }),
      ...ghlTagsFor({ event: "first_graded_call" }),
      ...(["upgrade", "downgrade", "churn"] as const).flatMap((event) => (["free", "pro", "team"] as const).flatMap((toPlan) => ghlTagsFor({ event, toPlan }))),
    ]);
    expect([...existing].sort()).toEqual(["app-calltrainer", "ct-activated", "ct-churned", "ct-paid-pro", "ct-paid-team", "ct-signed-up", "ct-signup-email", "ct-signup-google"]);
    for (const t of ghlTagsFor({ event: "voice_cap_hit" })) expect(existing.has(t)).toBe(true);
  });

  it("the sink forwards voice_cap_hit with the looked-up contact, and nothing else", async () => {
    on();
    mocks.prisma.user.findUnique.mockResolvedValue(freeUser);
    for (const other of [
      { name: "premium_added", subject: "user", subjectId: "u-1" },
      { name: "premium_fallback_to_standard", subject: "user", subjectId: "u-1", reason: "minutes_used" },
      { name: "premium_upsell_viewed", surface: "live" },
      capHit("cap_reached", { subject: "organization", subjectId: "org-1" }),
      capHit("cap_reached", { subjectId: undefined }),
      capHit("not_a_reason"),
    ] as PremiumEvent[]) ghlPremiumSink(other);
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();

    expect(ghlPremiumSink(capHit("cap_reached"))).toBeUndefined(); // returns at once; the claim, lookup and POST run in the background
    await settleGhlEvents();
    const bodies = sent().map((c) => c.body);
    expect(bodies).toEqual([
      expect.objectContaining({ event: "voice_cap_hit", userId: "u-1", organizationId: "org-1", email: "mia@example.test", plan: "free", reason: "cap_reached", tags: ["app-calltrainer"] }),
    ]);
    // Same kind of fields as the other payloads: no transcript, session, call or provider detail.
    expect(Object.keys(bodies[0]).sort()).toEqual(["app", "email", "event", "eventId", "occurredAt", "organizationId", "plan", "reason", "tags", "userId", "version"]);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-1" } }));
  });

  it("plan follows the allowance rule: Team for a member of an entitled Team org while billing is on, else the user's own plan", async () => {
    on();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    // Separate days, so each is the first cap hit of its day.
    mocks.prisma.user.findUnique.mockResolvedValue({ ...freeUser, organization: { ...freeUser.organization, planTier: "team" } });
    ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-05T12:00:00.000Z" }));
    await settleGhlEvents();
    mocks.prisma.user.findUnique.mockResolvedValue({ ...freeUser, planTier: "pro" });
    ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-06T12:00:00.000Z" }));
    await settleGhlEvents();
    expect(sent().map((c) => c.body.plan)).toEqual(["team", "pro"]);
  });

  it("a missing user or a failed contact lookup still sends, with email and plan null", async () => {
    on();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A missing user: the claim keys on the user, the lookup finds nobody.
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-05T12:00:00.000Z" }));
    await settleGhlEvents();
    // The claim reads the organization, then the contact lookup fails.
    mocks.prisma.user.findUnique.mockReset();
    mocks.prisma.user.findUnique.mockResolvedValueOnce(freeUser).mockRejectedValueOnce(new Error("db down"));
    ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-05T13:00:00.000Z" }));
    await settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([
      expect.objectContaining({ event: "voice_cap_hit", eventId: "voice_cap_hit:user:u-1:2026-11-05", email: null, plan: null, organizationId: null }),
      expect.objectContaining({ event: "voice_cap_hit", eventId: "voice_cap_hit:org-1:2026-11-05", email: null, plan: null, organizationId: "org-1" }),
    ]);
    expect(markers.map((m) => m.userId)).toEqual([null, "u-1"]);
    expect(errors.mock.calls.map((c) => c.join(" "))).toEqual(["[ghl] voice_cap_hit contact lookup failed; sending without email"]);
  });

  it("occurredAt and the dedupe date come from the event's queue time, not the send time", async () => {
    on();
    mocks.prisma.user.findUnique.mockResolvedValue(freeUser);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-06T00:00:00.200Z")); // the sink runs just after midnight UTC
      ghlPremiumSink(capHit("cap_reached", { occurredAt: "2026-11-05T23:59:59.800Z" })); // queued just before it
      ghlPremiumSink(capHit("cap_reached_in_call", { occurredAt: "not a date" })); // no valid stamp: the sink's time
      ghlPremiumSink(capHit("cap_reached_in_call")); // no stamp at all: the sink's time
    } finally {
      vi.useRealTimers();
    }
    await settleGhlEvents();
    // The queue time decides the day: the first counts for the 5th, the second for the 6th, the third repeats the 6th.
    expect(sent().map((c) => [c.body.occurredAt, c.body.eventId])).toEqual([
      ["2026-11-05T23:59:59.800Z", "voice_cap_hit:org-1:2026-11-05"],
      ["2026-11-06T00:00:00.200Z", "voice_cap_hit:org-1:2026-11-06"],
    ]);
  });

  it("does nothing while GHL events are off: no claim, no marker, no lookup, no POST", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(freeUser);
    ghlPremiumSink(capHit("cap_reached"));
    vi.stubEnv("GHL_BILLING_EVENTS", "true"); // the flag without a URL is still off
    ghlPremiumSink(capHit("cap_reached_in_call"));
    await settleGhlEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(markers).toEqual([]);
  });

  it("billing.ts registers the sink, and every route that emits voice_cap_hit loads billing.ts", async () => {
    vi.resetModules();
    const events = await import("@/lib/billingEvents");
    await import("@/lib/billing");
    const ghl = await import("@/lib/ghlWebhook");
    on();
    mocks.prisma.user.findUnique.mockResolvedValue(freeUser);
    await events.emitPremiumEvent(capHit("cap_reached"));
    await ghl.settleGhlEvents();
    expect(sent().map((c) => c.body)).toEqual([expect.objectContaining({ event: "voice_cap_hit", userId: "u-1" })]);

    for (const route of ["realtime/session", "elevenlabs/token", "usage/heartbeat"]) {
      const src = readFileSync(join(process.cwd(), "src/app/api", route, "route.ts"), "utf8");
      expect(src, route).toContain('import "@/lib/billing";');
    }
  });
});

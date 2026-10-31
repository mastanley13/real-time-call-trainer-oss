import { afterEach, describe, expect, it, vi } from "vitest";
import { createGhlClient, ghlEnabled } from "@/lib/ghl/client";
import { drainGhlOutbox, enqueueGhlEvent, backoffMs, dueHeads, MAX_ATTEMPTS, type OutboxRow, type OutboxStore } from "@/lib/ghl/outbox";
import { actionsFor, idempotencyKey, type GhlEvent, type GhlPayload } from "@/lib/ghl/types";
import { nextMilestone, confirmedSegment, isWentQuiet } from "@/lib/ghl/events";

const META = { eventId: "user_1:signup", sequence: 1 };
const TOKEN = "pit-test-token-0123456789";
const ENV = { GHL_SYNC_ENABLED: "true", GHL_PIT: TOKEN, GHL_LOCATION_ID: "loc_test" };
const EMAIL = "rep@example.com";

const payload = (event: GhlEvent, over: Partial<GhlPayload> = {}): GhlPayload => ({
  event,
  occurredAt: "2026-10-31T12:00:00.000Z",
  user: { id: "user_1", email: EMAIL, firstName: "Sam" },
  plan: "free",
  segment: null,
  minuteCap: 20,
  voiceMinutesUsed: 0,
  source: "landing/insurance",
  referredByPartner: null,
  stripeCustomerId: null,
  ...over,
});

const FIELD_KEYS = ["plan", "signup_date", "minute_cap", "voice_minutes_used", "last_active_date", "inbound_source", "referred_by_partner", "first_graded_call_date", "stripe_customer_id"];
const STAGES = ["Signed Up", "First Graded Call", "Active Trial", "Upgraded (Paid)", "Went Quiet"];

type Call = { method: string; url: string; body: any; headers: Record<string, string> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake GHL API. `fail` can inject a status for the first N calls to a path. */
function fakeGhl(opts: { failFirst?: { match: string; status: number; times: number; retryAfter?: string }; existingOpp?: boolean } = {}) {
  const calls: Call[] = [];
  let failed = 0;
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = { method: init.method ?? "GET", url, body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> };
    calls.push(call);
    const f = opts.failFirst;
    if (f && u.pathname.includes(f.match) && failed < f.times) {
      failed++;
      return json({ message: "secret provider body " + EMAIL }, f.status, f.retryAfter ? { "retry-after": f.retryAfter } : {});
    }
    const p = u.pathname;
    if (p === "/contacts/upsert") return json({ contact: { id: "c1" }, new: true });
    if (p.endsWith("/customFields")) return json({ customFields: FIELD_KEYS.map((k) => ({ id: `f_${k}`, fieldKey: `contact.${k}` })) });
    if (p === "/opportunities/pipelines") return json({ pipelines: [{ id: "p1", name: "Inbound Trials", stages: STAGES.map((n) => ({ id: `s_${n}`, name: n })) }] });
    if (p === "/opportunities/search") return json({ opportunities: opts.existingOpp ? [{ id: "o1" }] : [] });
    return json({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);
afterEach(() => {
  sleeps.length = 0;
  vi.restoreAllMocks();
});

describe("per-event GHL calls", () => {
  const cases: Array<{ event: GhlEvent; over?: Partial<GhlPayload>; stage: string; tags: string[]; fields: string[] }> = [
    { event: "signup", over: { segment: "insurance" }, stage: "Signed Up", tags: ["ct-trial", "seg-insurance"], fields: ["plan", "signup_date", "minute_cap", "voice_minutes_used", "last_active_date", "inbound_source", "referred_by_partner"] },
    { event: "first_graded_call", over: { voiceMinutesUsed: 6.5 }, stage: "First Graded Call", tags: ["ct-activated"], fields: ["first_graded_call_date", "voice_minutes_used", "last_active_date"] },
    { event: "active_trial", over: { voiceMinutesUsed: 12 }, stage: "Active Trial", tags: [], fields: ["voice_minutes_used", "last_active_date"] },
    { event: "upgrade", over: { plan: "pro", minuteCap: 300, stripeCustomerId: "cus_test" }, stage: "Upgraded (Paid)", tags: ["ct-paid-pro"], fields: ["plan", "minute_cap", "stripe_customer_id"] },
    { event: "upgrade", over: { plan: "team", minuteCap: 1000, stripeCustomerId: "cus_test" }, stage: "Upgraded (Paid)", tags: ["ct-paid-team"], fields: ["plan", "minute_cap", "stripe_customer_id"] },
    { event: "went_quiet", stage: "Went Quiet", tags: [], fields: ["last_active_date"] },
  ];

  for (const c of cases) {
    it(`${c.event}${c.over?.plan ? ` (${c.over.plan})` : ""}: stage, tags and fields`, async () => {
      const g = fakeGhl();
      await createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }).send(payload(c.event, c.over), META);

      const upsert = g.calls.find((x) => x.url.endsWith("/contacts/upsert"))!;
      expect(upsert.body).toMatchObject({ locationId: "loc_test", email: EMAIL });
      expect(upsert.headers).toMatchObject({ Version: "2021-07-28", Authorization: `Bearer ${TOKEN}` });

      const tagCall = g.calls.find((x) => x.url.endsWith("/contacts/c1/tags"));
      if (c.tags.length) expect(tagCall!.body.tags).toEqual(c.tags);
      else expect(tagCall).toBeUndefined();

      const put = g.calls.find((x) => x.method === "PUT" && x.url.endsWith("/contacts/c1"));
      expect(put!.body.customFields.map((f: { id: string }) => f.id).sort()).toEqual(c.fields.map((k) => `f_${k}`).sort());

      const opp = g.calls.find((x) => x.url.endsWith("/opportunities/") && x.method === "POST")!;
      expect(opp.body).toMatchObject({ pipelineId: "p1", pipelineStageId: `s_${c.stage}`, contactId: "c1", locationId: "loc_test" });
    });
  }

  it("moves an existing opportunity instead of creating a second one", async () => {
    const g = fakeGhl({ existingOpp: true });
    await createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }).send(payload("active_trial"), META);
    expect(g.calls.some((c) => c.method === "POST" && c.url.endsWith("/opportunities/"))).toBe(false);
    const move = g.calls.find((c) => c.method === "PUT" && c.url.endsWith("/opportunities/o1"))!;
    expect(move.body).toEqual({ pipelineStageId: "s_Active Trial" });
  });

  it("resolves field and pipeline ids once and caches them", async () => {
    const g = fakeGhl();
    const client = createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep });
    await client.send(payload("signup"), META);
    await client.send(payload("went_quiet"), META);
    expect(g.calls.filter((c) => c.url.endsWith("/customFields"))).toHaveLength(1);
    expect(g.calls.filter((c) => c.url.includes("/opportunities/pipelines"))).toHaveLength(1);
  });

  it("only touches contacts, tags, fields and opportunities (no email or SMS)", async () => {
    const g = fakeGhl();
    await createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }).send(payload("signup"), META);
    for (const c of g.calls) expect(c.url).not.toMatch(/conversations|messages|email|sms/i);
  });

  it("posts the event JSON to the webhook instead of the API when GHL_INBOUND_WEBHOOK_URL is set", async () => {
    const g = fakeGhl();
    const p = payload("signup");
    await createGhlClient({ env: { ...ENV, GHL_INBOUND_WEBHOOK_URL: "https://hooks.example.com/in" }, fetchImpl: g.fetchImpl, sleep }).send(p, META);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].url).toBe("https://hooks.example.com/in");
    expect(g.calls[0].body).toEqual({ ...p, ...META });
    expect(g.calls[0].headers["Idempotency-Key"]).toBe(META.eventId);
    expect(g.calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("actions", () => {
  it("adds seg-<x> only from a confirmed segment", () => {
    expect(actionsFor(payload("signup")).addTags).toEqual(["ct-trial"]);
    expect(actionsFor(payload("signup", { segment: "solar" })).addTags).toEqual(["ct-trial", "seg-solar"]);
    expect(confirmedSegment("solar")).toBe("solar");
    expect(confirmedSegment("plumbing")).toBeNull();
    expect(confirmedSegment(undefined)).toBeNull();
  });
  it("went_quiet keeps ct-trial", () => {
    const a = actionsFor(payload("went_quiet"));
    expect(a.removeTags).toEqual([]);
    expect(a.addTags).toEqual([]);
  });
});

describe("retry", () => {
  it("retries on 429, honouring Retry-After, then succeeds", async () => {
    const g = fakeGhl({ failFirst: { match: "/contacts/upsert", status: 429, times: 2, retryAfter: "2" } });
    await createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }).send(payload("signup"), META);
    expect(g.calls.filter((c) => c.url.endsWith("/contacts/upsert"))).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("retries 5xx with exponential backoff and gives up after maxAttempts", async () => {
    const g = fakeGhl({ failFirst: { match: "/contacts/upsert", status: 503, times: 99 } });
    await expect(createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep, maxAttempts: 3 }).send(payload("signup"), META)).rejects.toMatchObject({ status: 503 });
    expect(g.calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("does not retry a 4xx other than 429", async () => {
    const g = fakeGhl({ failFirst: { match: "/contacts/upsert", status: 401, times: 99 } });
    await expect(createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }).send(payload("signup"), META)).rejects.toMatchObject({ status: 401 });
    expect(g.calls).toHaveLength(1);
  });
});

describe("gating", () => {
  it("is off by default, in demo mode, and without credentials", () => {
    expect(ghlEnabled({})).toBe(false);
    expect(ghlEnabled({ ...ENV, GHL_SYNC_ENABLED: "" })).toBe(false);
    expect(ghlEnabled({ ...ENV, DEMO_MODE: "true" })).toBe(false);
    expect(ghlEnabled({ GHL_SYNC_ENABLED: "true" })).toBe(false);
    expect(ghlEnabled(ENV)).toBe(true);
    expect(ghlEnabled({ GHL_SYNC_ENABLED: "true", GHL_INBOUND_WEBHOOK_URL: "https://hooks.example.com/in" })).toBe(true);
  });

  it("enqueue and drain are no-ops when disabled, in demo mode and under the test default", async () => {
    for (const env of [{}, { ...ENV, GHL_SYNC_ENABLED: "false" }, { ...ENV, DEMO_MODE: "true" }]) {
      const store = memoryStore();
      const send = vi.fn();
      expect(await enqueueGhlEvent(payload("signup"), { store, env })).toBe(false);
      expect(store.rows).toHaveLength(0);
      const r = await drainGhlOutbox({ store, env, client: { send } });
      expect(r).toEqual({ sent: 0, retried: 0, dead: 0, skipped: 0 });
      expect(send).not.toHaveBeenCalled();
    }
  });
});

describe("outbox", () => {
  it("dedupes on the idempotency key", async () => {
    const store = memoryStore();
    expect(await enqueueGhlEvent(payload("signup"), { store, env: ENV })).toBe(true);
    expect(await enqueueGhlEvent(payload("signup"), { store, env: ENV })).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].idempotencyKey).toBe("user_1:signup");
  });

  it("keys one-shot events by <userId>:<event> and repeatable ones by date too", () => {
    expect(idempotencyKey("u", "signup", "2026-10-31T01:00:00Z")).toBe("u:signup");
    expect(idempotencyKey("u", "first_graded_call", "2026-10-31T01:00:00Z")).toBe("u:first_graded_call");
    expect(idempotencyKey("u", "upgrade", "2026-10-31T01:00:00Z")).toBe("u:upgrade");
    expect(idempotencyKey("u", "went_quiet", "2026-10-31T01:00:00Z")).toBe("u:went_quiet:2026-10-31");
    expect(idempotencyKey("u", "active_trial", "2026-10-31T01:00:00Z")).toBe("u:active_trial:2026-10-31");
  });

  it("sends, then marks retryable failures for backoff and permanent ones dead", async () => {
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup"), { store, env: ENV });
    await enqueueGhlEvent(payload("upgrade", { user: { id: "user_2", email: EMAIL, firstName: "" } }), { store, env: ENV });
    await enqueueGhlEvent(payload("first_graded_call", { user: { id: "user_3", email: EMAIL, firstName: "" } }), { store, env: ENV });
    const { GhlHttpError } = await import("@/lib/ghl/client");
    const client = {
      send: vi.fn(async (p: GhlPayload) => {
        if (p.user.id === "user_2") throw new GhlHttpError(503);
        if (p.user.id === "user_3") throw new GhlHttpError(401);
      }),
    };
    const now = new Date("2026-10-31T12:00:00Z");
    const r = await drainGhlOutbox({ store, env: ENV, client, now: () => now });
    expect(r).toEqual({ sent: 1, retried: 1, dead: 1, skipped: 0 });
    const by = (id: string) => store.rows.find((x) => x.userId === id)!;
    expect(by("user_1").status).toBe("done");
    expect(by("user_2")).toMatchObject({ status: "pending", attempts: 1, lastError: "http_503" });
    expect(by("user_2").nextAttemptAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(by("user_3")).toMatchObject({ status: "dead", lastError: "http_401" });

    // Not due yet: nothing is retried early.
    expect((await drainGhlOutbox({ store, env: ENV, client, now: () => now })).retried).toBe(0);
  });

  it("goes dead after MAX_ATTEMPTS retryable failures", async () => {
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup"), { store, env: ENV });
    store.rows[0].attempts = MAX_ATTEMPTS - 1;
    const { GhlHttpError } = await import("@/lib/ghl/client");
    const r = await drainGhlOutbox({ store, env: ENV, client: { send: async () => { throw new GhlHttpError(429); } } });
    expect(r.dead).toBe(1);
    expect(store.rows[0].status).toBe("dead");
  });

  it("backoff grows and is capped", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
  });

  it("an enqueue failure never throws", async () => {
    const store = memoryStore();
    store.insert = async () => { throw new Error("db down"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(enqueueGhlEvent(payload("signup"), { store, env: ENV })).resolves.toBe(false);
  });
});

describe("logs", () => {
  it("never contain the token, the email or a provider body", async () => {
    const lines: string[] = [];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));

    // Failing API (provider body echoes the email) through the client retries and the outbox.
    const g = fakeGhl({ failFirst: { match: "/contacts/upsert", status: 503, times: 99 } });
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup"), { store, env: ENV });
    await drainGhlOutbox({ store, env: ENV, client: createGhlClient({ env: ENV, fetchImpl: g.fetchImpl, sleep }) });
    // Also a permanent failure and a success.
    const ok = fakeGhl();
    await enqueueGhlEvent(payload("upgrade", { plan: "pro" }), { store, env: ENV });
    await drainGhlOutbox({ store, env: ENV, client: createGhlClient({ env: ENV, fetchImpl: ok.fetchImpl, sleep }), now: () => new Date(Date.now() + 10 * 3_600_000) });

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("secret provider body");
    expect(all).toContain("user_1");
  });
});

describe("decisions", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  const createdAt = new Date("2026-11-01T00:00:00Z");
  const base = { createdAt, now, plan: "free", issued: new Set<string>(["signup"]), lastEvent: "signup" as string | null, gradedCount: 1 };
  it("hands out first_graded_call, then active_trial, then nothing, by what was already issued", () => {
    expect(nextMilestone({ ...base })).toBe("first_graded_call");
    expect(nextMilestone({ ...base, gradedCount: 2, issued: new Set(["signup", "first_graded_call"]), lastEvent: "first_graded_call" })).toBe("active_trial");
    expect(nextMilestone({ ...base, gradedCount: 3, issued: new Set(["signup", "first_graded_call", "active_trial"]), lastEvent: "active_trial" })).toBeNull();
  });
  it("needs a second committed graded call for active_trial", () => {
    expect(nextMilestone({ ...base, gradedCount: 1, issued: new Set(["signup", "first_graded_call"]), lastEvent: "first_graded_call" })).toBeNull();
  });
  it("second call after 7 days is not active_trial", () => {
    expect(nextMilestone({ ...base, createdAt: new Date("2026-10-20T00:00:00Z"), gradedCount: 2, issued: new Set(["signup", "first_graded_call"]), lastEvent: "first_graded_call" })).toBeNull();
  });
  it("a call after went_quiet moves back to active_trial, within the trial", () => {
    const quiet = { ...base, gradedCount: 5, issued: new Set(["signup", "first_graded_call", "active_trial", "went_quiet"]), lastEvent: "went_quiet" };
    expect(nextMilestone(quiet)).toBe("active_trial");
    expect(nextMilestone({ ...quiet, createdAt: new Date("2026-09-01T00:00:00Z") })).toBeNull();
  });
  it("paid users never move back", () => {
    expect(nextMilestone({ ...base, plan: "pro" })).toBeNull();
  });
  it("nothing without a committed graded call", () => {
    expect(nextMilestone({ ...base, gradedCount: 0 })).toBeNull();
  });
  it("went quiet after 7 days idle or when the trial ended unpaid", () => {
    const t = new Date("2026-11-30T00:00:00Z");
    expect(isWentQuiet({ createdAt: new Date("2026-11-25T00:00:00Z"), lastActive: new Date("2026-11-25T00:00:00Z"), now: t, plan: "free" })).toBe(false);
    expect(isWentQuiet({ createdAt: new Date("2026-11-20T00:00:00Z"), lastActive: new Date("2026-11-21T00:00:00Z"), now: t, plan: "free" })).toBe(true);
    expect(isWentQuiet({ createdAt: new Date("2026-11-01T00:00:00Z"), lastActive: new Date("2026-11-29T00:00:00Z"), now: t, plan: "free" })).toBe(true);
    expect(isWentQuiet({ createdAt: new Date("2026-11-01T00:00:00Z"), lastActive: new Date("2026-11-01T00:00:00Z"), now: t, plan: "pro" })).toBe(false);
  });
});

type MemRow = OutboxRow & { status: string; nextAttemptAt: Date; lastError?: string | null };
function memoryStore(): OutboxStore & { rows: MemRow[] } {
  const rows: MemRow[] = [];
  let n = 0;
  return {
    rows,
    async insert(r) {
      if (rows.some((x) => x.idempotencyKey === r.idempotencyKey)) return false;
      n++;
      rows.push({ id: `r${n}`, seq: n, ...r, attempts: 0, status: "pending", nextAttemptAt: new Date(0) });
      return true;
    },
    async due(limit, now) {
      return dueHeads(rows.filter((x) => x.status === "pending"), now, limit);
    },
    async claim(id, now, lease) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "pending" || r.nextAttemptAt > now) return false;
      r.nextAttemptAt = lease;
      return true;
    },
    async markDone(id) {
      rows.find((x) => x.id === id)!.status = "done";
    },
    async markRetry(id, attempts, next, err) {
      Object.assign(rows.find((x) => x.id === id)!, { attempts, nextAttemptAt: next, lastError: err });
    },
    async markDead(id, attempts, err) {
      Object.assign(rows.find((x) => x.id === id)!, { status: "dead", attempts, lastError: err });
    },
  };
}

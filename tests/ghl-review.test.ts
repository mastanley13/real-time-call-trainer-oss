import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGhlClient, GhlHttpError } from "@/lib/ghl/client";
import { drainGhlOutbox, enqueueGhlEvent, dueHeads, type OutboxRow, type OutboxStore } from "@/lib/ghl/outbox";
import { enqueueGradedCall, scanWentQuiet, SCAN_PAGE_SIZE } from "@/lib/ghl/events";
import type { GhlDeliveryMeta, GhlPayload, GhlWebhookBody } from "@/lib/ghl/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- A small in-memory Prisma, just enough for the scan and milestone code ----
const h = vi.hoisted(() => ({
  state: { now: new Date(), users: [] as any[], sessions: [] as any[], outbox: [] as any[], seq: 0 },
}));

vi.mock("@/lib/db", async () => {
  const { Prisma } = await import("@prisma/client");
  const s = h.state;
  const sessionMatches = (x: any, w: any): boolean => {
    if (w.userId !== undefined) {
      if (typeof w.userId === "string" ? x.userId !== w.userId : !w.userId.in.includes(x.userId)) return false;
    }
    if (w.overallScore && x.overallScore === null) return false;
    if (w.OR && !w.OR.some((c: any) => (c.createdAt?.lt ? x.createdAt < c.createdAt.lt : x.createdAt.getTime() === c.createdAt.getTime() && x.id < c.id.lt))) return false;
    return true;
  };
  const prisma = {
    user: {
      findMany: async ({ where, take, cursor, skip }: any) => {
        let rows = s.users.filter((u) => u.createdAt < where.createdAt.lt && u.createdAt > where.createdAt.gt).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cursor) rows = rows.slice(rows.findIndex((u) => u.id === cursor.id) + (skip ?? 0));
        return rows.slice(0, take);
      },
      findUnique: async ({ where }: any) => {
        const u = s.users.find((x) => x.id === where.id);
        return u ? { ...u, organization: { planTier: "free" } } : null;
      },
    },
    trainerSession: {
      count: async ({ where }: any) => s.sessions.filter((x) => sessionMatches(x, where)).length,
      findFirst: async ({ where }: any) => s.sessions.filter((x) => sessionMatches(x, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      aggregate: async ({ where }: any) => ({ _sum: { durationSeconds: s.sessions.filter((x) => sessionMatches(x, where)).reduce((n, x) => n + x.durationSeconds, 0) } }),
      groupBy: async ({ where }: any) => {
        const ids: string[] = where.userId.in;
        return ids.flatMap((userId) => {
          const mine = s.sessions.filter((x) => x.userId === userId);
          if (!mine.length) return [];
          return [{ userId, _max: { createdAt: new Date(Math.max(...mine.map((x) => x.createdAt.getTime()))) }, _sum: { durationSeconds: mine.reduce((n, x) => n + x.durationSeconds, 0) } }];
        });
      },
    },
    ghlOutbox: {
      create: async ({ data }: any) => {
        if (s.outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
        s.outbox.push({ ...data, seq: ++s.seq, status: "pending", attempts: 0, createdAt: new Date(s.now) });
      },
      findFirst: async ({ where }: any) => s.outbox.filter((r) => r.userId === where.userId && r.event === where.event).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      groupBy: async ({ where }: any) => {
        const ids: string[] = where.userId.in;
        return ids.flatMap((userId) => {
          const mine = s.outbox.filter((r) => r.userId === userId && r.event === where.event);
          return mine.length ? [{ userId, _max: { createdAt: new Date(Math.max(...mine.map((r) => r.createdAt.getTime()))) } }] : [];
        });
      },
    },
  };
  return { prisma };
});

const HOOK = "https://hooks.example.com/in";
const payload = (event: GhlPayload["event"], userId: string): GhlPayload => ({
  event,
  occurredAt: "2026-10-31T12:00:00.000Z",
  user: { id: userId, email: "rep@example.com", firstName: "Sam" },
  plan: "free",
  segment: null,
  minuteCap: 20,
  voiceMinutesUsed: 0,
  source: null,
  referredByPartner: null,
  stripeCustomerId: null,
});

const ENV = { GHL_SYNC_ENABLED: "true", GHL_INBOUND_WEBHOOK_URL: HOOK };
const sleep = async () => {};

describe("webhook delivery is idempotent at the receiver", () => {
  it("a POST accepted but whose response is lost is re-sent with the same event id, and the receiver keeps one", async () => {
    const received = new Map<string, GhlWebhookBody>();
    const keys: string[] = [];
    let lose = 1;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["Idempotency-Key"];
      keys.push(key);
      if (!received.has(key)) received.set(key, JSON.parse(init.body as string)); // the receiver processed it...
      if (lose-- > 0) throw new Error("timeout"); // ...but the response never arrived
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const meta: GhlDeliveryMeta = { eventId: "user_1:signup", sequence: 7 };
    await createGhlClient({ env: ENV, fetchImpl, sleep }).send(payload("signup", "user_1"), meta);

    expect(keys).toEqual(["user_1:signup", "user_1:signup"]);
    expect(received.size).toBe(1);
    expect(received.get("user_1:signup")).toMatchObject({ eventId: "user_1:signup", sequence: 7, event: "signup" });
  });

  it("a failed markDone redelivers the same event id and sequence", async () => {
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup", "user_1"), { store, env: ENV });
    const seen: GhlDeliveryMeta[] = [];
    const client = { send: async (_p: GhlPayload, m: GhlDeliveryMeta) => void seen.push(m) };
    const markDone = store.markDone;
    let failOnce = true;
    store.markDone = async (id, now) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("db blip");
      }
      return markDone(id, now);
    };
    const t0 = new Date("2026-10-31T12:00:00Z");
    await drainGhlOutbox({ store, env: ENV, client, now: () => t0 });
    await drainGhlOutbox({ store, env: ENV, client, now: () => new Date(t0.getTime() + 10 * 60_000) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0].eventId).toBe("user_1:signup");
  });
});

describe("per-user ordering", () => {
  const t0 = new Date("2026-10-31T12:00:00Z");

  it("dueHeads only offers a user's earliest pending row, and only when it is due", () => {
    const row = (seq: number, userId: string, due: number) => ({ id: `r${seq}`, idempotencyKey: `k${seq}`, seq, event: "x", userId, payload: {}, attempts: 0, nextAttemptAt: new Date(due) });
    const rows = [row(1, "a", 5_000), row(2, "a", 0), row(3, "b", 0)];
    expect(dueHeads(rows, new Date(0), 10).map((r) => r.seq)).toEqual([3]); // a's head is backing off, so a's seq 2 waits
    expect(dueHeads(rows, new Date(5_000), 10).map((r) => r.seq)).toEqual([1, 3]);
  });

  it("a later event waits while signup backs off, then both go out in order", async () => {
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup", "user_1"), { store, env: ENV });
    await enqueueGhlEvent(payload("first_graded_call", "user_1"), { store, env: ENV });
    await enqueueGhlEvent(payload("signup", "user_2"), { store, env: ENV });
    const sent: Array<[string, string, number]> = [];
    let failSignup = true;
    const client = {
      send: async (p: GhlPayload, m: GhlDeliveryMeta) => {
        if (p.user.id === "user_1" && p.event === "signup" && failSignup) throw new GhlHttpError(503);
        sent.push([p.user.id, p.event, m.sequence]);
      },
    };

    await drainGhlOutbox({ store, env: ENV, client, now: () => t0 });
    expect(sent).toEqual([["user_2", "signup", 3]]); // user_1's first_graded_call did not jump the queue; user_2 is unaffected

    failSignup = false;
    await drainGhlOutbox({ store, env: ENV, client, now: () => new Date(t0.getTime() + 5 * 60_000) });
    expect(sent.filter(([u]) => u === "user_1").map(([, e]) => e)).toEqual(["signup", "first_graded_call"]);
    const seqs = sent.filter(([u]) => u === "user_1").map(([, , s]) => s);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("a dead signup releases the user's later events", async () => {
    const store = memoryStore();
    await enqueueGhlEvent(payload("signup", "user_1"), { store, env: ENV });
    await enqueueGhlEvent(payload("first_graded_call", "user_1"), { store, env: ENV });
    const sent: string[] = [];
    const client = {
      send: async (p: GhlPayload) => {
        if (p.event === "signup") throw new GhlHttpError(401);
        sent.push(p.event);
      },
    };
    const r = await drainGhlOutbox({ store, env: ENV, client, now: () => t0 });
    expect(r).toMatchObject({ dead: 1, sent: 1 });
    expect(sent).toEqual(["first_graded_call"]);
  });

  it("concurrent drainers never deliver one user's events at once, and send each event once", async () => {
    const store = memoryStore();
    for (const u of ["user_1", "user_2"]) {
      await enqueueGhlEvent(payload("signup", u), { store, env: ENV });
      await enqueueGhlEvent(payload("first_graded_call", u), { store, env: ENV });
    }
    const inFlight = new Set<string>();
    let overlap = false;
    const sent: string[] = [];
    const client = {
      send: async (p: GhlPayload) => {
        if (inFlight.has(p.user.id)) overlap = true;
        inFlight.add(p.user.id);
        await new Promise((r) => setTimeout(r, 5));
        inFlight.delete(p.user.id);
        sent.push(`${p.user.id}:${p.event}`);
      },
    };
    const now = () => new Date("2026-10-31T12:00:00Z");
    await Promise.all([drainGhlOutbox({ store, env: ENV, client, now }), drainGhlOutbox({ store, env: ENV, client, now })]);
    await drainGhlOutbox({ store, env: ENV, client, now });
    expect(overlap).toBe(false);
    expect([...sent].sort()).toEqual(["user_1:first_graded_call", "user_1:signup", "user_2:first_graded_call", "user_2:signup"]);
    expect(sent.indexOf("user_1:signup")).toBeLessThan(sent.indexOf("user_1:first_graded_call"));
  });
});

describe("quiet scan pagination", () => {
  const now = new Date("2026-11-30T00:00:00Z");
  beforeEach(() => {
    vi.stubEnv("GHL_SYNC_ENABLED", "true");
    vi.stubEnv("GHL_INBOUND_WEBHOOK_URL", HOOK);
    h.state.now = now;
    h.state.users = [];
    h.state.sessions = [];
    h.state.outbox = [];
    h.state.seq = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("queues every candidate past one page, and a rerun queues nobody twice", async () => {
    const total = SCAN_PAGE_SIZE * 2 + 200;
    const created = new Date("2026-11-10T00:00:00Z"); // trial over by 11-24, so all are quiet
    h.state.users = Array.from({ length: total }, (_, i) => ({ id: `u${String(i).padStart(5, "0")}`, email: `u${i}@example.com`, firstName: "Sam", createdAt: created }));

    expect(await scanWentQuiet(now)).toBe(total);
    expect(h.state.outbox).toHaveLength(total);
    expect(new Set(h.state.outbox.map((r) => r.userId)).size).toBe(total);

    expect(await scanWentQuiet(now)).toBe(0);
    expect(h.state.outbox).toHaveLength(total);
  });

  it("keeps going when an earlier page was already processed", async () => {
    const created = new Date("2026-11-10T00:00:00Z");
    const total = SCAN_PAGE_SIZE + 50;
    h.state.users = Array.from({ length: total }, (_, i) => ({ id: `u${String(i).padStart(5, "0")}`, email: `u${i}@example.com`, firstName: "Sam", createdAt: created }));
    // The first page is already queued from an earlier run.
    for (const u of h.state.users.slice(0, SCAN_PAGE_SIZE)) {
      h.state.outbox.push({ idempotencyKey: `${u.id}:went_quiet:old`, event: "went_quiet", userId: u.id, seq: ++h.state.seq, createdAt: new Date("2026-11-29T00:00:00Z") });
    }
    expect(await scanWentQuiet(now)).toBe(50);
  });
});

describe("race-safe milestones", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  beforeEach(() => {
    vi.stubEnv("GHL_SYNC_ENABLED", "true");
    vi.stubEnv("GHL_INBOUND_WEBHOOK_URL", HOOK);
    h.state.now = now;
    h.state.users = [{ id: "u1", email: "rep@example.com", firstName: "Sam", createdAt: new Date("2026-11-04T00:00:00Z") }];
    h.state.outbox = [];
    h.state.seq = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const session = (id: string, at: string) => ({ id, userId: "u1", createdAt: new Date(at), overallScore: 80, durationSeconds: 300 });
  const keys = () => h.state.outbox.map((r) => r.idempotencyKey).sort();

  it("two graded sessions saved before either callback runs still yield first_graded_call and active_trial", async () => {
    const a = session("a", "2026-11-04T10:00:00Z");
    const b = session("b", "2026-11-04T10:00:05Z");
    h.state.sessions = [a, b]; // both are stored; neither callback has run yet
    // Callbacks run in the "wrong" order, and each sees a total of 2 graded calls.
    expect(await enqueueGradedCall("u1", b)).toBe("active_trial");
    expect(await enqueueGradedCall("u1", a)).toBe("first_graded_call");
    expect(keys()).toEqual(["u1:active_trial:2026-11-04", "u1:first_graded_call"]);
  });

  it("breaks a createdAt tie by id", async () => {
    const a = session("a", "2026-11-04T10:00:00Z");
    const b = session("b", "2026-11-04T10:00:00Z");
    h.state.sessions = [a, b];
    expect(await enqueueGradedCall("u1", a)).toBe("first_graded_call");
    expect(await enqueueGradedCall("u1", b)).toBe("active_trial");
  });

  it("ungraded earlier sessions do not count", async () => {
    const ungraded = { ...session("a", "2026-11-04T09:00:00Z"), overallScore: null };
    const graded = session("b", "2026-11-04T10:00:00Z");
    h.state.sessions = [ungraded, graded];
    expect(await enqueueGradedCall("u1", graded)).toBe("first_graded_call");
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

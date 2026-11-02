import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGhlClient, GhlHttpError } from "@/lib/ghl/client";
import { drainGhlOutbox, enqueueGhlEvent, dueHeads, type OutboxRow, type OutboxStore } from "@/lib/ghl/outbox";
import { enqueueGradedCall, enqueueSignup, enqueueUpgrade, scanWentQuiet } from "@/lib/ghl/events";
import type { GhlDeliveryMeta, GhlPayload, GhlWebhookBody } from "@/lib/ghl/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- A small in-memory Prisma: models, transactions, and per-key advisory locks ----
const h = vi.hoisted(() => ({
  state: { now: new Date(), users: [] as any[], sessions: [] as any[], outbox: [] as any[], cursors: new Map<string, string>(), seq: 0, slow: false },
}));

vi.mock("@/lib/db", () => {
  const s = h.state;
  // Opt-in (state.slow): widens race windows so interleaving really happens, without slowing the big scan tests.
  const tick = () => (s.slow ? new Promise((r) => setTimeout(r, 1)) : Promise.resolve());
  const matches = (x: any, w: any): boolean => {
    if (w.userId !== undefined && (typeof w.userId === "string" ? x.userId !== w.userId : !w.userId.in.includes(x.userId))) return false;
    if (w.overallScore && x.overallScore === null) return false;
    return true;
  };
  const models = {
    user: {
      findMany: async ({ where, take, cursor, skip }: any) => {
        let rows = s.users.filter((u) => u.createdAt < where.createdAt.lt && u.createdAt > where.createdAt.gt).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cursor) rows = rows.slice(rows.findIndex((u) => u.id === cursor.id) + (skip ?? 0));
        return rows.slice(0, take);
      },
      findUnique: async ({ where }: any) => {
        await tick();
        const u = s.users.find((x) => x.id === where.id);
        return u ? { ...u, organization: { planTier: u.planTier ?? "free" } } : null;
      },
    },
    trainerSession: {
      count: async ({ where }: any) => {
        await tick();
        return s.sessions.filter((x) => matches(x, where)).length;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const dir = orderBy?.createdAt === "asc" ? 1 : -1;
        return s.sessions.filter((x) => matches(x, where)).sort((a, b) => dir * (a.createdAt - b.createdAt))[0] ?? null;
      },
      aggregate: async ({ where }: any) => {
        const mine = s.sessions.filter((x) => matches(x, where));
        return { _sum: { durationSeconds: mine.reduce((n, x) => n + x.durationSeconds, 0) }, _max: { createdAt: mine.length ? new Date(Math.max(...mine.map((x) => x.createdAt.getTime()))) : null } };
      },
      groupBy: async ({ where }: any) => {
        const ids: string[] = where.userId.in;
        return ids.flatMap((userId) => {
          const mine = s.sessions.filter((x) => x.userId === userId);
          return mine.length ? [{ userId, _max: { createdAt: new Date(Math.max(...mine.map((x) => x.createdAt.getTime()))) } }] : [];
        });
      },
    },
    ghlOutbox: {
      createMany: async ({ data }: any) => {
        await tick();
        let count = 0;
        for (const d of data) {
          if (s.outbox.some((r) => r.idempotencyKey === d.idempotencyKey)) continue;
          s.outbox.push({ ...d, seq: ++s.seq, status: "pending", attempts: 0, createdAt: new Date(s.now) });
          count++;
        }
        return { count };
      },
      findMany: async ({ where }: any) => {
        await tick();
        return s.outbox.filter((r) => r.userId === where.userId).sort((a, b) => a.seq - b.seq);
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
    ghlScanCursor: {
      findUnique: async ({ where }: any) => (s.cursors.has(where.name) ? { name: where.name, lastId: s.cursors.get(where.name) } : null),
      upsert: async ({ where, create }: any) => void s.cursors.set(where.name, create.lastId),
    },
  };
  // pg_advisory_xact_lock(hashtext(key)): FIFO mutex per key, released when the transaction ends.
  const locks = new Map<string, Promise<void>>();
  const prisma = {
    ...models,
    $transaction: async (fn: any) => {
      const held: Array<() => void> = [];
      const tx = {
        ...models,
        $executeRaw: async (_strings: any, key: string) => {
          const prev = locks.get(key) ?? Promise.resolve();
          let release!: () => void;
          locks.set(key, prev.then(() => new Promise<void>((r) => (release = r))));
          await prev;
          held.push(release);
          return 1;
        },
      };
      try {
        return await fn(tx);
      } finally {
        held.forEach((r) => r());
      }
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

function resetDb(now: Date) {
  h.state.now = now;
  h.state.users = [];
  h.state.sessions = [];
  h.state.outbox = [];
  h.state.cursors = new Map();
  h.state.seq = 0;
  h.state.slow = false;
}
const enableSync = () => {
  vi.stubEnv("GHL_SYNC_ENABLED", "true");
  vi.stubEnv("GHL_INBOUND_WEBHOOK_URL", HOOK);
  vi.spyOn(console, "log").mockImplementation(() => {});
};
const quietUsers = (n: number, created = new Date("2026-11-10T00:00:00Z")) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(5, "0")}`, email: `u${i}@example.com`, firstName: "Sam", createdAt: created }));
/** Events for a user in seq (delivery) order. */
const eventsOf = (userId: string) => h.state.outbox.filter((r) => r.userId === userId).sort((a, b) => a.seq - b.seq).map((r) => r.event);
const wentQuietRows = () => h.state.outbox.filter((r) => r.event === "went_quiet");

describe("quiet scan advances across runs", () => {
  const now = new Date("2026-11-30T00:00:00Z");
  beforeEach(() => {
    resetDb(now);
    enableSync();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("queues every candidate past one page, and a rerun queues nobody twice", async () => {
    h.state.users = quietUsers(1200);
    expect(await scanWentQuiet(now)).toBe(1200);
    expect(wentQuietRows()).toHaveLength(1200);
    expect(new Set(wentQuietRows().map((r) => r.userId)).size).toBe(1200);
    expect(await scanWentQuiet(now)).toBe(0);
    expect(wentQuietRows()).toHaveLength(1200);
  });

  it("with a per-run page budget smaller than the backlog, successive runs cover everyone exactly once", async () => {
    // 95 candidates, 10 per page, 3 pages per run: a run reads 30 users, so it takes 4 runs.
    h.state.users = quietUsers(95);
    const opts = { pageSize: 10, maxPages: 3 };
    const perRun: number[] = [];
    for (let run = 0; run < 4; run++) perRun.push(await scanWentQuiet(now, opts));
    expect(perRun).toEqual([30, 30, 30, 5]);
    expect(new Set(wentQuietRows().map((r) => r.userId)).size).toBe(95);
    expect(wentQuietRows()).toHaveLength(95);
    // The pass finished, so the cursor reset; a further run starts over and finds nothing new.
    expect(h.state.cursors.get("went_quiet")).toBe("");
    expect(await scanWentQuiet(now, opts)).toBe(0);
  });

  it("does not stall when the backlog is an exact multiple of the run budget", async () => {
    h.state.users = quietUsers(60);
    const opts = { pageSize: 10, maxPages: 3 };
    expect(await scanWentQuiet(now, opts)).toBe(30);
    expect(await scanWentQuiet(now, opts)).toBe(30);
    expect(await scanWentQuiet(now, opts)).toBe(0);
    // A user who goes quiet later is picked up within the next runs: the cursor wrapped, and the wrap-around
    // pass spends part of one run's budget re-reading users that are already queued.
    h.state.users.push(...quietUsers(61).slice(60));
    const later = (await scanWentQuiet(now, opts)) + (await scanWentQuiet(now, opts));
    expect(later).toBe(1);
    expect(wentQuietRows()).toHaveLength(61);
  });

  it("keeps going past users that an earlier run already queued", async () => {
    h.state.users = quietUsers(25);
    for (const u of h.state.users.slice(0, 20)) {
      h.state.outbox.push({ idempotencyKey: `${u.id}:went_quiet:old`, event: "went_quiet", userId: u.id, seq: ++h.state.seq, createdAt: new Date("2026-11-29T00:00:00Z") });
    }
    expect(await scanWentQuiet(now, { pageSize: 10, maxPages: 5 })).toBe(5);
  });

  it("puts signup ahead of went_quiet for a user who has no signup row yet", async () => {
    h.state.users = quietUsers(1);
    await scanWentQuiet(now);
    expect(eventsOf("u00000")).toEqual(["signup", "went_quiet"]);
  });
});

describe("lifecycle-ordered milestones", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  beforeEach(() => {
    resetDb(now);
    h.state.slow = true;
    enableSync();
    h.state.users = [{ id: "u1", email: "rep@example.com", firstName: "Sam", createdAt: new Date("2026-11-04T00:00:00Z") }];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const session = (id: string, at: string) => ({ id, userId: "u1", createdAt: new Date(at), overallScore: 80, durationSeconds: 300 });
  const A = session("a", "2026-11-04T10:00:00Z");
  const B = session("b", "2026-11-04T10:00:05Z");
  const LIFECYCLE = ["signup", "first_graded_call", "active_trial"];

  it("out-of-order callbacks still deliver signup, first_graded_call, active_trial in that order", async () => {
    h.state.sessions = [A, B];
    // The second call's callback runs first.
    await enqueueGradedCall("u1", B);
    await enqueueGradedCall("u1", A);
    expect(eventsOf("u1")).toEqual(LIFECYCLE);
    const first = h.state.outbox.find((r) => r.event === "first_graded_call");
    expect(first.payload.occurredAt).toBe(A.createdAt.toISOString()); // dated by the earliest committed graded call
  });

  it("concurrent first calls each get exactly one milestone, in lifecycle order", async () => {
    h.state.sessions = [A, B];
    const [x, y] = await Promise.all([enqueueGradedCall("u1", B), enqueueGradedCall("u1", A)]);
    expect([x, y].sort()).toEqual(["active_trial", "first_graded_call"]);
    expect(eventsOf("u1")).toEqual(LIFECYCLE);
    expect(new Set(h.state.outbox.map((r) => r.idempotencyKey)).size).toBe(3);
  });

  it("an earlier session that is still uncommitted when a later one's callback runs does not lose active_trial", async () => {
    h.state.sessions = [B]; // A has not committed yet, so B's callback cannot see it
    expect(await enqueueGradedCall("u1", B)).toBe("first_graded_call");
    h.state.sessions = [A, B]; // A commits; its callback runs
    expect(await enqueueGradedCall("u1", A)).toBe("active_trial");
    expect(eventsOf("u1")).toEqual(LIFECYCLE);
  });

  it("a third call adds nothing", async () => {
    h.state.sessions = [A, B, session("c", "2026-11-04T11:00:00Z")];
    await enqueueGradedCall("u1", A);
    await enqueueGradedCall("u1", B);
    expect(await enqueueGradedCall("u1", h.state.sessions[2])).toBeNull();
    expect(eventsOf("u1")).toEqual(LIFECYCLE);
  });

  it("ungraded sessions do not count", async () => {
    h.state.sessions = [{ ...session("a", "2026-11-04T09:00:00Z"), overallScore: null }, B];
    expect(await enqueueGradedCall("u1", B)).toBe("first_graded_call");
    expect(await enqueueGradedCall("u1", B)).toBeNull(); // only one graded call so far, so no active_trial
  });

  it("a delayed signup callback neither duplicates signup nor jumps ahead of later events", async () => {
    h.state.sessions = [A];
    expect(await enqueueGradedCall("u1", A)).toBe("first_graded_call"); // signup was never queued; it is created first
    await enqueueSignup("u1"); // the late signup callback
    expect(eventsOf("u1")).toEqual(["signup", "first_graded_call"]);
  });

  it("signup, graded callbacks and a late signup racing each other still produce one ordered lifecycle", async () => {
    h.state.sessions = [A, B];
    await Promise.all([enqueueGradedCall("u1", B), enqueueGradedCall("u1", A), enqueueSignup("u1")]);
    expect(eventsOf("u1")).toEqual(LIFECYCLE);
  });

  it("upgrade after no signup row still goes out after signup", async () => {
    await enqueueUpgrade({ userId: "u1", plan: "pro", stripeCustomerId: "cus_test" });
    expect(eventsOf("u1")).toEqual(["signup", "upgrade"]);
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

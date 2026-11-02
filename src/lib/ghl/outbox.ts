import "server-only";
import { Prisma } from "@prisma/client";
import { createGhlClient, ghlEnabled, GhlHttpError, isRetryable, type GhlClient } from "./client";
import { ghlLog } from "./log";
import { GhlPayloadSchema, idempotencyKey, type GhlPayload } from "./types";

export type OutboxRow = { id: string; idempotencyKey: string; seq: number; event: string; userId: string; payload: unknown; attempts: number };

/** A pending row plus when it may next be tried. */
export type PendingRow = OutboxRow & { nextAttemptAt: Date };

/**
 * Per-user ordering. `pending` is every pending row; only each user's earliest one (lowest seq) is a
 * candidate, and only once it is due. A later event therefore waits while an earlier one is backing
 * off or leased by another worker, and is released when the earlier one is done or dead.
 */
export function dueHeads<T extends PendingRow>(pending: T[], now: Date, limit: number): T[] {
  const heads = new Map<string, T>();
  for (const r of pending) {
    const h = heads.get(r.userId);
    if (!h || r.seq < h.seq) heads.set(r.userId, r);
  }
  return [...heads.values()].filter((r) => r.nextAttemptAt <= now).sort((a, b) => a.seq - b.seq).slice(0, limit);
}

/** Storage seam so the queue logic is testable without a database. */
export interface OutboxStore {
  /** Returns false when a row with this key already exists. */
  insert(row: { idempotencyKey: string; event: string; userId: string; payload: GhlPayload }): Promise<boolean>;
  due(limit: number, now: Date): Promise<OutboxRow[]>;
  /** Leases the row so two workers do not send it twice. False when someone else got it. */
  claim(id: string, now: Date, leaseUntil: Date): Promise<boolean>;
  markDone(id: string, now: Date): Promise<void>;
  markRetry(id: string, attempts: number, nextAttemptAt: Date, lastError: string): Promise<void>;
  markDead(id: string, attempts: number, lastError: string): Promise<void>;
}

export const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const MAX_ROUNDS = 5;

/** 1 min, 2, 4, ... capped at 6 hours. */
export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);

/**
 * Pass a transaction client to insert inside the caller's per-user locked section (see events.ts).
 * Without one, the shared client is loaded lazily so demo mode and tests never construct it.
 */
export function prismaOutboxStore(client?: Prisma.TransactionClient): OutboxStore {
  const db = async () => client ?? (await import("@/lib/db")).prisma;
  return {
    async insert(row) {
      // skipDuplicates: a duplicate key is a no-op, not an error, so it cannot abort an open Postgres transaction.
      const r = await (await db()).ghlOutbox.createMany({ data: [{ ...row, payload: row.payload as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
      return r.count === 1;
    },
    async due(limit, now) {
      // distinct + orderBy seq keeps the first (lowest seq) pending row per user; dueHeads then drops
      // users whose head is not due yet, so nothing skips ahead of a row that is backing off or leased.
      const heads = await (await db()).ghlOutbox.findMany({
        where: { status: "pending" },
        orderBy: { seq: "asc" },
        distinct: ["userId"],
        select: { id: true, idempotencyKey: true, seq: true, event: true, userId: true, payload: true, attempts: true, nextAttemptAt: true },
      });
      return dueHeads(heads, now, limit);
    },
    async claim(id, now, leaseUntil) {
      const r = await (await db()).ghlOutbox.updateMany({ where: { id, status: "pending", nextAttemptAt: { lte: now } }, data: { nextAttemptAt: leaseUntil } });
      return r.count === 1;
    },
    async markDone(id, now) {
      await (await db()).ghlOutbox.update({ where: { id }, data: { status: "done", sentAt: now, lastError: null } });
    },
    async markRetry(id, attempts, nextAttemptAt, lastError) {
      await (await db()).ghlOutbox.update({ where: { id }, data: { attempts, nextAttemptAt, lastError } });
    },
    async markDead(id, attempts, lastError) {
      await (await db()).ghlOutbox.update({ where: { id }, data: { status: "dead", attempts, lastError } });
    },
  };
}

type Deps = { store?: OutboxStore; env?: Record<string, string | undefined> };

/**
 * Queue one event. No-op when sync is off. Never throws: a queue failure is logged and dropped
 * so the user action that triggered it is unaffected. Returns true when a new row was queued.
 */
export async function enqueueGhlEvent(payload: GhlPayload, deps: Deps = {}): Promise<boolean> {
  try {
    if (!ghlEnabled(deps.env ?? process.env)) return false;
    const parsed = GhlPayloadSchema.parse(payload);
    const key = idempotencyKey(parsed.user.id, parsed.event, parsed.occurredAt);
    const created = await (deps.store ?? prismaOutboxStore()).insert({ idempotencyKey: key, event: parsed.event, userId: parsed.user.id, payload: parsed });
    ghlLog("info", created ? "queued" : "duplicate_skipped", { userId: parsed.user.id, event: parsed.event, key });
    return created;
  } catch {
    ghlLog("error", "enqueue_failed", { userId: payload?.user?.id, event: payload?.event });
    return false;
  }
}

export type DrainResult = { sent: number; retried: number; dead: number; skipped: number };

/** Send due rows. Retryable failures back off; permanent ones (and exhausted retries) go dead. */
export async function drainGhlOutbox(opts: Deps & { client?: GhlClient; limit?: number; now?: () => Date } = {}): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retried: 0, dead: 0, skipped: 0 };
  const env = opts.env ?? process.env;
  if (!ghlEnabled(env)) return result;
  const store = opts.store ?? prismaOutboxStore();
  const client = opts.client ?? createGhlClient({ env });
  const now = opts.now ?? (() => new Date());

  // A user's next event only becomes due once the previous one is done, so go round a few times to
  // deliver a user's events back to back. Backed-off rows are not due, so this always ends.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const rows = await store.due(opts.limit ?? 25, now());
    if (!rows.length) break;
    const before = result.sent + result.retried + result.dead;
    await Promise.all(rows.map((row) => deliver(row)));
    if (result.sent + result.retried + result.dead === before) break;
  }
  return result;

  async function deliver(row: OutboxRow) {
    const t = now();
    if (!(await store.claim(row.id, t, new Date(t.getTime() + LEASE_MS)))) {
      result.skipped++;
      return;
    }
    const attempts = row.attempts + 1;
    const parsed = GhlPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      await store.markDead(row.id, attempts, "invalid_payload");
      ghlLog("error", "dead", { userId: row.userId, event: row.event, outcome: "invalid_payload" });
      result.dead++;
      return;
    }
    try {
      // The eventId is stable across every redelivery of this row (retry, crash, failed markDone).
      await client.send(parsed.data, { eventId: row.idempotencyKey, sequence: row.seq });
      await store.markDone(row.id, now());
      ghlLog("info", "sent", { userId: row.userId, event: row.event, attempt: attempts });
      result.sent++;
    } catch (e) {
      const status = e instanceof GhlHttpError ? e.status : 0;
      const code = `http_${status}`;
      if (isRetryable(status) && attempts < MAX_ATTEMPTS) {
        await store.markRetry(row.id, attempts, new Date(now().getTime() + backoffMs(attempts)), code);
        ghlLog("warn", "will_retry", { userId: row.userId, event: row.event, status, attempt: attempts });
        result.retried++;
      } else {
        await store.markDead(row.id, attempts, code);
        ghlLog("error", "dead", { userId: row.userId, event: row.event, status, attempt: attempts });
        result.dead++;
      }
    }
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";

/**
 * A small in-memory stand-in for the Prisma models that metering and billing touch. It supports exactly the
 * query shapes those modules use, unique-key errors (P2002) and transaction rollback, and nothing else.
 */

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

const UNIQUE: Record<string, string[][]> = {
  user: [["id"], ["email"], ["stripeCustomerId"], ["stripeSubscriptionId"]],
  organization: [["id"], ["code"], ["stripeCustomerId"], ["stripeSubscriptionId"]],
  usageAllowance: [["id"], ["userId"], ["organizationId"]],
  usageEntry: [["id"], ["trainerSessionId", "kind"]],
  trainerSession: [["id"]],
  stripeEvent: [["id"]],
  auditEvent: [["id"]],
};

const NO_CHECKOUT = { stripeCheckoutSessionId: null, stripeCheckoutFingerprint: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null };

const DEFAULTS: Record<string, () => Record<string, unknown>> = {
  user: () => ({ voiceBlockedUntil: null, planTier: "free", premiumVoice: false, premiumVoiceQuantity: 0, subscriptionPeriodEnd: null, premiumVoiceRemoveAt: null, premiumSuspendedAt: null, premiumSuspendedInvoiceId: null, premiumScheduleRef: null, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, pastDueSince: null, ...NO_CHECKOUT, organizationId: null, role: "trainee", isPlatformAdmin: false, createdAt: new Date(), usageAnchorAt: new Date() }),
  organization: () => ({ planTier: "free", seatCount: 1, premiumVoice: false, premiumVoiceQuantity: 0, subscriptionPeriodEnd: null, premiumVoiceRemoveAt: null, seatCountAtRenewal: null, premiumSuspendedAt: null, premiumSuspendedInvoiceId: null, premiumScheduleRef: null, premiumTrialCallUsedAt: null, premiumTrialCallSessionId: null, voiceModelTier: null, voiceModelComped: null, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, pastDueSince: null, ...NO_CHECKOUT, createdAt: new Date() }),
  usageAllowance: () => ({ userId: null, organizationId: null, minutesUsed: 0, minutesReserved: 0, premiumMinutesCap: 0, premiumMinutesUsed: 0, premiumMinutesReserved: 0, version: 0 }),
  usageEntry: () => ({ trainerSessionId: null, ranFrom: null, ranTo: null, createdAt: new Date() }),
  trainerSession: () => ({ connectedAt: null, endedAt: null, endReason: null, lastHeartbeatAt: null, degradedAt: null, billableSeconds: 0, billedMinutes: 0, durationSeconds: 0, allowanceId: null, allowancePeriodStart: null, reservedMinutes: 0, engineTier: "standard", voiceTier: null, realtimeModel: null, premiumTrial: false, premiumReservedMinutes: 0, carriedMinutes: 0, carriedPremiumMinutes: 0, abuseFlagged: false, capEnforced: true, createdAt: new Date() }),
  stripeEvent: () => ({ processedAt: new Date() }),
  auditEvent: () => ({}),
};

const isDate = (v: unknown): v is Date => v instanceof Date;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const have = row[k] ?? null;
    if (isDate(v)) return isDate(have) && have.getTime() === v.getTime();
    if (v && typeof v === "object") {
      const o = v as { lt?: Date; gte?: Date; gt?: number; in?: unknown[]; not?: unknown };
      // { not: null } is "set", { not: x } is "anything but x" (scalar values only).
      if ("not" in o && (o.not === null || typeof o.not !== "object")) return have !== (o.not ?? null);
      if (o.in) return o.in.includes(have);
      if (o.gt !== undefined) return typeof have === "number" && have > o.gt;
      if (o.lt) return isDate(have) && have.getTime() < o.lt.getTime();
      if (o.gte) return isDate(have) && have.getTime() >= o.gte.getTime();
      return true; // NOT / JSON filters are not modelled
    }
    return have === (v ?? null);
  });
}

export function createFakePrisma() {
  let seq = 0;
  let data: Record<string, Row[]> = Object.fromEntries(Object.keys(UNIQUE).map((t) => [t, []]));
  const failOnce: Record<string, number> = {};
  // Open transaction snapshots, innermost last, and one-shot hooks that run another writer's committed work.
  const open: { snapshot: Record<string, Row[]> }[] = [];
  const hooks: { table: string; method: string; when: (args: { where: Where; data: Record<string, unknown> }) => boolean; run: () => Promise<void> }[] = [];

  /**
   * Runs `run` as a transaction that committed from outside: its writes land in the live data and in the snapshot of
   * every open transaction, so a rollback of the transaction it interrupted does not undo it.
   */
  async function commitElsewhere(run: () => Promise<void>) {
    const live = data;
    for (const t of open) {
      data = t.snapshot;
      await run();
      t.snapshot = data;
    }
    data = live;
    await run();
  }
  async function fire(tableName: string, method: string, args: { where: Where; data: Record<string, unknown> }) {
    const i = hooks.findIndex((h) => h.table === tableName && h.method === method && h.when(args));
    if (i < 0) return;
    const [hook] = hooks.splice(i, 1);
    await commitElsewhere(hook.run);
  }

  const dupError = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });

  /** Every query in call order: `table.method`, or `raw:<sql>` for a raw query (row and advisory locks). */
  const calls: string[] = [];
  function table(name: string) {
    const rows = () => data[name];
    const log = (method: string) => calls.push(`${name}.${method}`);
    const copy = (r: Row | undefined | null) => (r ? { ...r } : null);
    const withInclude = (r: Row | null, args?: { include?: { organization?: boolean } }) => {
      if (!r) return null;
      if (name === "user" && args?.include?.organization) {
        const org = data.organization.find((o) => o.id === r.organizationId);
        return { ...r, organization: org ? { ...org } : null };
      }
      return { ...r };
    };
    const find = (where: Where) => rows().find((r) => matches(r, where));
    const apply = (r: Row, patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v && typeof v === "object" && !isDate(v) && ("increment" in v || "decrement" in v)) {
          const o = v as { increment?: number; decrement?: number };
          r[k] = (r[k] as number) + (o.increment ?? 0) - (o.decrement ?? 0);
        } else r[k] = v;
      }
    };
    return {
      findUnique: async (args: { where: Where; include?: { organization?: boolean } }) => { log("findUnique"); return withInclude(find(args.where) ?? null, args); },
      findUniqueOrThrow: async (args: { where: Where; include?: { organization?: boolean } }) => {
        log("findUniqueOrThrow");
        const r = find(args.where);
        if (!r) throw new Error(`${name} not found`);
        return withInclude(r, args);
      },
      findMany: async (args: { where?: Where; take?: number; orderBy?: { createdAt: "desc" | "asc" } } = {}) => {
        let out = rows().filter((r) => matches(r, args.where ?? {}));
        if (args.orderBy) out = [...out].sort((a, b) => ((a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()) * (args.orderBy!.createdAt === "desc" ? -1 : 1));
        return out.slice(0, args.take ?? out.length).map((r) => ({ ...r }));
      },
      findFirst: async (args: { where?: Where } = {}) => { log("findFirst"); return copy(rows().find((r) => matches(r, args.where ?? {}))); },
      count: async (args: { where?: Where } = {}) => rows().filter((r) => matches(r, args.where ?? {})).length,
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `${name}-${++seq}`, ...DEFAULTS[name](), ...Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined)) } as Row;
        for (const keys of UNIQUE[name]) {
          if (keys.some((k) => row[k] === null || row[k] === undefined)) continue;
          if (rows().some((r) => keys.every((k) => r[k] === row[k]))) throw dupError();
        }
        rows().push(row);
        return { ...row };
      },
      update: async (args: { where: Where; data: Record<string, unknown> }) => {
        log("update");
        await fire(name, "update", args);
        if (failOnce[name] > 0) { failOnce[name] -= 1; throw new Error("injected failure"); }
        const r = find(args.where);
        if (!r) throw new Error(`${name} not found`);
        apply(r, args.data);
        return { ...r };
      },
      updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
        await fire(name, "updateMany", args);
        const hit = rows().filter((r) => matches(r, args.where));
        hit.forEach((r) => apply(r, args.data));
        return { count: hit.length };
      },
      deleteMany: async (args: { where?: Where } = {}) => {
        const gone = rows().filter((r) => matches(r, args.where ?? {}));
        // In place, so anything holding the array from rows() still sees the live data.
        for (const r of gone) rows().splice(rows().indexOf(r), 1);
        // UsageEntry.trainerSession is onDelete: SetNull, so a purged call leaves its ledger entries unlinked, not deleted.
        if (name === "trainerSession") {
          for (const e of data.usageEntry) if (gone.some((g) => g.id === e.trainerSessionId)) e.trainerSessionId = null;
        }
        return { count: gone.length };
      },
      _copy: copy,
    };
  }

  const rawQueries: { sql: string; values: unknown[] }[] = [];
  // Row locks (see $queryRaw): which transaction holds each FOR UPDATE row, and what each transaction releases at its end.
  const txScope = new AsyncLocalStorage<object>();
  let rowLocking = false;
  const rowLocks = new Map<string, { owner: object; released: Promise<void> }>();
  const releasers = new Map<object, Array<() => void>>();
  const db = {
    user: table("user"),
    organization: table("organization"),
    usageAllowance: table("usageAllowance"),
    usageEntry: table("usageEntry"),
    trainerSession: table("trainerSession"),
    stripeEvent: table("stripeEvent"),
    auditEvent: table("auditEvent"),
    /**
     * Records raw queries (row and advisory locks). With enableRowLocks(), a SELECT ... FOR UPDATE also takes that row's
     * lock for the calling transaction until it ends: another transaction asking for the same row waits, the way
     * Postgres blocks it, and the same transaction may ask again. Off by default, because interleave() hooks model a
     * commit landing between a read and a write, which a held row lock would block.
     */
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      rawQueries.push({ sql, values });
      calls.push(`raw:${sql}`);
      const owner = txScope.getStore();
      if (rowLocking && owner && /FOR UPDATE/.test(sql)) {
        const key = `${sql}:${values.join(",")}`;
        for (let held = rowLocks.get(key); held && held.owner !== owner; held = rowLocks.get(key)) await held.released;
        if (!rowLocks.has(key)) {
          let release!: () => void;
          const released = new Promise<void>((r) => { release = r; });
          rowLocks.set(key, { owner, released });
          const mine = releasers.get(owner) ?? [];
          mine.push(() => { rowLocks.delete(key); release(); });
          releasers.set(owner, mine);
        }
      }
      return [];
    },
    /** Runs fn on the same store; a throw restores the data as it was, like a rolled-back transaction. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const entry = { snapshot: structuredClone(data) };
      open.push(entry);
      const owner = {};
      try {
        return await txScope.run(owner, () => fn(db));
      } catch (e) {
        data = entry.snapshot;
        throw e;
      } finally {
        open.splice(open.indexOf(entry), 1);
        for (const release of releasers.get(owner) ?? []) release();
        releasers.delete(owner);
      }
    },
  };

  return {
    db,
    rawQueries,
    calls,
    /** Direct access to rows for arranging and asserting. */
    rows: (name: keyof typeof UNIQUE) => data[name],
    seed: (name: keyof typeof UNIQUE, row: Record<string, unknown>) => {
      const r = { id: `${name}-${++seq}`, ...DEFAULTS[name](), ...row } as Row;
      data[name].push(r);
      return r;
    },
    /**
     * Just before the next matching write on `table`, runs `run` as if another connection committed it at that
     * moment. Models the interleavings a real database allows between a transaction's read and its write.
     */
    interleave: (table: keyof typeof UNIQUE, method: "update" | "updateMany", run: () => Promise<void>, when: (args: { where: Where; data: Record<string, unknown> }) => boolean = () => true) => {
      hooks.push({ table, method, when, run });
    },
    failNextUpdate: (name: keyof typeof UNIQUE) => { failOnce[name] = 1; },
    /** Makes SELECT ... FOR UPDATE block other transactions until the holder ends (see $queryRaw). */
    enableRowLocks: () => { rowLocking = true; },
  };
}

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
  user: () => ({ planTier: "free", premiumVoice: false, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, ...NO_CHECKOUT, organizationId: null, role: "trainee", isPlatformAdmin: false, createdAt: new Date(), usageAnchorAt: new Date() }),
  organization: () => ({ planTier: "free", seatCount: 1, premiumVoice: false, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, ...NO_CHECKOUT, createdAt: new Date() }),
  usageAllowance: () => ({ userId: null, organizationId: null, minutesUsed: 0, minutesReserved: 0, premiumMinutesUsed: 0, version: 0 }),
  usageEntry: () => ({ trainerSessionId: null, createdAt: new Date() }),
  trainerSession: () => ({ connectedAt: null, endedAt: null, endReason: null, lastHeartbeatAt: null, degradedAt: null, billableSeconds: 0, billedMinutes: 0, durationSeconds: 0, allowanceId: null, allowancePeriodStart: null, reservedMinutes: 0, engineTier: "standard", createdAt: new Date() }),
  stripeEvent: () => ({ processedAt: new Date() }),
  auditEvent: () => ({}),
};

const isDate = (v: unknown): v is Date => v instanceof Date;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const have = row[k] ?? null;
    if (isDate(v)) return isDate(have) && have.getTime() === v.getTime();
    if (v && typeof v === "object") {
      const o = v as { lt?: Date; gte?: Date };
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

  const dupError = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });

  function table(name: string) {
    const rows = () => data[name];
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
      findUnique: async (args: { where: Where; include?: { organization?: boolean } }) => withInclude(find(args.where) ?? null, args),
      findUniqueOrThrow: async (args: { where: Where; include?: { organization?: boolean } }) => {
        const r = find(args.where);
        if (!r) throw new Error(`${name} not found`);
        return withInclude(r, args);
      },
      findMany: async (args: { where?: Where; take?: number; orderBy?: { createdAt: "desc" | "asc" } } = {}) => {
        let out = rows().filter((r) => matches(r, args.where ?? {}));
        if (args.orderBy) out = [...out].sort((a, b) => ((a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()) * (args.orderBy!.createdAt === "desc" ? -1 : 1));
        return out.slice(0, args.take ?? out.length).map((r) => ({ ...r }));
      },
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
        if (failOnce[name] > 0) { failOnce[name] -= 1; throw new Error("injected failure"); }
        const r = find(args.where);
        if (!r) throw new Error(`${name} not found`);
        apply(r, args.data);
        return { ...r };
      },
      updateMany: async (args: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows().filter((r) => matches(r, args.where));
        hit.forEach((r) => apply(r, args.data));
        return { count: hit.length };
      },
      _copy: copy,
    };
  }

  const db = {
    user: table("user"),
    organization: table("organization"),
    usageAllowance: table("usageAllowance"),
    usageEntry: table("usageEntry"),
    trainerSession: table("trainerSession"),
    stripeEvent: table("stripeEvent"),
    auditEvent: table("auditEvent"),
    /** Runs fn on the same store; a throw restores the data as it was, like a rolled-back transaction. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(data);
      try {
        return await fn(db);
      } catch (e) {
        data = snapshot;
        throw e;
      }
    },
  };

  return {
    db,
    /** Direct access to rows for arranging and asserting. */
    rows: (name: keyof typeof UNIQUE) => data[name],
    seed: (name: keyof typeof UNIQUE, row: Record<string, unknown>) => {
      const r = { id: `${name}-${++seq}`, ...DEFAULTS[name](), ...row } as Row;
      data[name].push(r);
      return r;
    },
    failNextUpdate: (name: keyof typeof UNIQUE) => { failOnce[name] = 1; },
  };
}

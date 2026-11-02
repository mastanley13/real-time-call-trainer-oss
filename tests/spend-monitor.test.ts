import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// A one-row stand-in for SpendState plus the user and audit tables the reset route touches.
type Row = Record<string, unknown> & { tripped: boolean; dailyCapDay: string | null; alertedThresholds: number[] };
const db = vi.hoisted(() => ({
  row: null as Row | null,
  failRead: false,
  admins: new Set<string>(),
  audits: [] as Array<Record<string, unknown>>,
  writes: 0,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    spendState: {
      findUnique: async () => {
        if (db.failRead) throw new Error("connection refused");
        return db.row ? { ...db.row } : null;
      },
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        db.writes++;
        db.row = db.row
          ? ({ ...db.row, ...update } as Row)
          : ({ tripped: false, trippedAt: null, tripReason: null, dailyCapDay: null, budgetPeriod: null, alertedThresholds: [], lastStatus: null, ...create } as Row);
        return { ...db.row };
      },
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => ({ isPlatformAdmin: db.admins.has(where.id) }) },
    auditEvent: { create: async ({ data }: { data: Record<string, unknown> }) => (db.audits.push(data), data) },
  },
}));

import { creditExpiredBlock, spendConfig } from "@/lib/spendConfig";
import { runSpendMonitor } from "@/lib/spendMonitor";
import { STATE_CACHE_MS, readSpendTrip, resetSpendStateCache } from "@/lib/spendState";
import { REALTIME_MINUTES_PER_CALL, paidFeaturesGuard, paidFeaturesSwitchGuard, reserveRealtimeCall, resetSpendGuard } from "@/lib/spendGuard";
import { DEMO_USER } from "@/lib/serverConfig";
import { GET as cronGET } from "@/app/api/cron/spend-monitor/route";
import { POST as resetPOST } from "@/app/api/spend/reset/route";
import { POST as llmCheckPOST } from "@/app/api/llm/check/route";

const ADMIN_KEY = "test-admin-key-placeholder";
const PROJECT = "proj_calltrainer";
const NOW = Date.UTC(2026, 10, 2, 12); // 2026-11-02 12:00 UTC
const TODAY = Date.UTC(2026, 10, 2) / 1000;
const YESTERDAY = TODAY - 86_400;
const WEBHOOK = "https://hooks.example.test/spend";

interface Bucket { start_time: number; results: Array<Record<string, unknown>> }
const result = (value: number, project: string | null = PROJECT) => ({ object: "organization.costs.result", amount: { value, currency: "usd" }, project_id: project, line_item: null });
const bucket = (start: number, ...results: Array<Record<string, unknown>>): Bucket => ({ start_time: start, results });
const page = (data: Bucket[], next: string | null = null) => ({ object: "page", data, has_more: next !== null, next_page: next });

/** Costs pages keyed by the `page` cursor ("" is the first page); usage always one small bucket. */
let costPages: Record<string, unknown> = {};
let costStatus = 200;
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.href.startsWith(WEBHOOK)) return new Response(null, { status: 204 });
  if (url.pathname === "/v1/organization/costs") {
    if (costStatus !== 200) return new Response(`{"error":{"message":"secret detail ${ADMIN_KEY}"}}`, { status: costStatus });
    const body = costPages[url.searchParams.get("page") ?? ""];
    return Response.json(body);
  }
  if (url.pathname === "/v1/organization/usage/completions") {
    return Response.json(page([bucket(TODAY, { num_model_requests: 3, input_tokens: 100, output_tokens: 40 })]));
  }
  throw new Error(`unexpected fetch ${url.pathname} ${init?.method ?? "GET"}`);
});
const setCost = (total: number, today = 0) => {
  costPages = { "": page([bucket(YESTERDAY, result(total - today)), bucket(TODAY, result(today))]) };
};
const webhookEvents = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith(WEBHOOK)).map(([, init]) => JSON.parse(String(init?.body)));

function configure() {
  vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
  vi.stubEnv("OPENAI_ADMIN_KEY", ADMIN_KEY);
  vi.stubEnv("OPENAI_PROJECT_ID", PROJECT);
  vi.stubEnv("SPEND_BUDGET_START", "2026-10-01");
  vi.stubEnv("SPEND_ALERT_WEBHOOK_URL", WEBHOOK);
}
const cronReq = (auth?: string) => new NextRequest("http://localhost/api/cron/spend-monitor", { headers: auth ? { authorization: auth } : {} });
let ip = 0;
const postReq = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++ip % 250}` },
  body: JSON.stringify(body),
});

let logs: string[] = [];
beforeEach(() => {
  db.row = null;
  db.failRead = false;
  db.admins.clear();
  db.audits = [];
  db.writes = 0;
  costPages = {};
  costStatus = 200;
  fetchMock.mockClear();
  resetSpendStateCache();
  resetSpendGuard();
  for (const name of ["OPENAI_ADMIN_KEY", "OPENAI_PROJECT_ID", "SPEND_BUDGET_START", "SPEND_BUDGET_USD", "SPEND_CREDIT_EXPIRES_AT",
    "SPEND_ALLOW_CARD_CHARGES", "SPEND_DAILY_CEILING_USD", "SPEND_ALERT_WEBHOOK_URL", "DATABASE_URL", "PAID_FEATURES_ENABLED", "DAILY_REALTIME_MINUTES_CAP"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("threshold alerts", () => {
  it("fires once at each of $250, $375 and $450, and not again on the next run", async () => {
    configure();
    const thresholdsFired = () => webhookEvents().filter((e) => e.event === "spend.threshold").map((e) => e.thresholdUsd);

    setCost(100);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([]);

    setCost(260);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([50]);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([]);
    expect(thresholdsFired()).toEqual([250]);

    setCost(380);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([75]);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([]);
    expect(thresholdsFired()).toEqual([250, 375]);
    expect(db.row?.tripped).toBe(false);

    setCost(455);
    const at90 = await runSpendMonitor(NOW);
    expect(at90.alerted).toEqual([90]);
    expect(at90.status).toBe("tripped");
    expect((await runSpendMonitor(NOW)).alerted).toEqual([]);
    expect(thresholdsFired()).toEqual([250, 375, 450]);
    expect(webhookEvents().filter((e) => e.event === "spend.tripped")).toHaveLength(1);
    expect(db.row?.alertedThresholds).toEqual([50, 75, 90]);
    // Every alert is also a log line.
    expect(logs.filter((l) => l.includes('"event":"spend.threshold"'))).toHaveLength(3);
  });

  it("fires every threshold a single jump crosses", async () => {
    configure();
    setCost(470);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([50, 75, 90]);
  });

  it("starts over when the budget period changes", async () => {
    configure();
    setCost(260);
    await runSpendMonitor(NOW);
    vi.stubEnv("SPEND_BUDGET_START", "2026-11-01");
    expect((await runSpendMonitor(NOW)).alerted).toEqual([50]);
  });

  it("logs only without a webhook", async () => {
    configure();
    vi.stubEnv("SPEND_ALERT_WEBHOOK_URL", "");
    setCost(260);
    expect((await runSpendMonitor(NOW)).alerted).toEqual([50]);
    expect(webhookEvents()).toEqual([]);
    expect(logs.some((l) => l.includes('"thresholdUsd":250'))).toBe(true);
  });
});

describe("automatic kill switch", () => {
  it("trips at 90% and every paid route then answers 503 paid_features_off", async () => {
    configure();
    setCost(450);
    const run = await runSpendMonitor(NOW);
    expect(run).toMatchObject({ status: "tripped", tripped: true, tripReason: "budget_90_percent" });
    expect(db.row).toMatchObject({ tripped: true, tripReason: "budget_90_percent" });

    const guard = await paidFeaturesGuard(NOW);
    expect(guard?.status).toBe(503);
    expect((await guard!.json()).error).toBe("paid_features_off");
    expect((await paidFeaturesSwitchGuard(NOW))?.status).toBe(503);

    // Another instance (empty cache) reads the trip from the row.
    resetSpendStateCache();
    const res = await llmCheckPOST(postReq("/api/llm/check", {}));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("paid_features_off");
  });

  it("does not trip below 90%", async () => {
    configure();
    setCost(449.99);
    expect((await runSpendMonitor(NOW)).tripped).toBe(false);
    expect(await paidFeaturesGuard(NOW)).toBeNull();
  });

  it("stays tripped until cleared, and re-trips on the next run while still over", async () => {
    configure();
    db.admins.add(DEMO_USER.id);
    setCost(460);
    await runSpendMonitor(NOW);
    const cleared = await resetPOST(postReq("/api/spend/reset", { reason: "raised project limit" }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ ok: true, wasTripped: true, tripReason: "budget_90_percent" });
    expect(db.audits[0]).toMatchObject({ action: "spend.trip_cleared", userId: DEMO_USER.id });
    expect(await paidFeaturesGuard(NOW)).toBeNull();

    await runSpendMonitor(NOW);
    expect(db.row?.tripped).toBe(true);
    expect(webhookEvents().filter((e) => e.event === "spend.tripped")).toHaveLength(2);
  });

  it("reset is platform admins only", async () => {
    configure();
    db.row = { tripped: true, dailyCapDay: null, alertedThresholds: [] };
    const res = await resetPOST(postReq("/api/spend/reset", { reason: "x" }));
    expect(res.status).toBe(403);
    expect(db.row.tripped).toBe(true);
  });
});

describe("credit expiry", () => {
  const AFTER = Date.UTC(2026, 10, 29, 1);

  it("defaults to 2026-11-29", () => {
    configure();
    const cfg = spendConfig();
    expect(cfg.ok && cfg.config.creditExpiresAt.toISOString()).toBe("2026-11-29T00:00:00.000Z");
  });

  it("trips once the credit has expired, whatever the spend", async () => {
    configure();
    setCost(12);
    expect((await runSpendMonitor(NOW)).tripped).toBe(false);
    const run = await runSpendMonitor(AFTER);
    expect(run).toMatchObject({ status: "tripped", tripReason: "credit_expired" });
    expect(webhookEvents().find((e) => e.event === "spend.tripped")?.reason).toBe("credit_expired");
  });

  it("the guard refuses after expiry even before the next hourly run", async () => {
    configure();
    expect(creditExpiredBlock(NOW)).toBe(false);
    expect(creditExpiredBlock(AFTER)).toBe(true);
    expect((await paidFeaturesGuard(AFTER))?.status).toBe(503);
  });

  it("allows card spend only with SPEND_ALLOW_CARD_CHARGES=true", async () => {
    configure();
    vi.stubEnv("SPEND_ALLOW_CARD_CHARGES", "true");
    setCost(12);
    expect((await runSpendMonitor(AFTER)).tripped).toBe(false);
    expect(await paidFeaturesGuard(AFTER)).toBeNull();
  });

  it("does nothing when the monitor is not configured", async () => {
    expect(creditExpiredBlock(AFTER)).toBe(false);
    expect(await paidFeaturesGuard(AFTER)).toBeNull();
  });
});

describe("daily ceiling", () => {
  it("marks today when SPEND_DAILY_CEILING_USD is reached, until midnight UTC", async () => {
    configure();
    vi.stubEnv("SPEND_DAILY_CEILING_USD", "20");
    setCost(100, 25);
    const run = await runSpendMonitor(NOW);
    expect(run).toMatchObject({ todayCostUsd: 25, dailyCeilingHit: true, tripped: false });
    expect(db.row?.dailyCapDay).toBe("2026-11-02");
    const guard = await paidFeaturesGuard(NOW);
    expect((await guard!.json()).error).toBe("daily_cap_reached");
    expect(await paidFeaturesGuard(Date.UTC(2026, 10, 3, 0, 0, 30))).toBeNull();
  });

  it("an instance that hits DAILY_REALTIME_MINUTES_CAP turns paid routes off on every instance for the day", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
    vi.stubEnv("DAILY_REALTIME_MINUTES_CAP", String(REALTIME_MINUTES_PER_CALL));
    expect(reserveRealtimeCall(NOW)).not.toBeNull();
    await vi.waitFor(() => expect(db.row?.dailyCapDay).toBe("2026-11-02"));
    // A fresh instance: no in-memory reservations, no cache.
    resetSpendGuard();
    resetSpendStateCache();
    const guard = await paidFeaturesGuard(NOW);
    expect((await guard!.json()).error).toBe("daily_cap_reached");
    // The call that took the last minutes still connects.
    expect(await paidFeaturesSwitchGuard(NOW)).toBeNull();
  });
});

describe("costs API", () => {
  it("sums every page and skips other projects", async () => {
    configure();
    costPages = {
      "": page([bucket(YESTERDAY - 86_400, result(100.25)), bucket(YESTERDAY, result(50.5))], "cursor-2"),
      "cursor-2": page([bucket(TODAY, result(20), result(999, "proj_other"))], "cursor-3"),
      "cursor-3": page([bucket(TODAY, result(0.25))]),
    };
    const run = await runSpendMonitor(NOW);
    expect(run.periodCostUsd).toBe(171);
    expect(run.todayCostUsd).toBe(20.25);
    expect(run.usageToday).toEqual({ requests: 3, inputTokens: 100, outputTokens: 40 });

    const costCalls = fetchMock.mock.calls.map(([u]) => new URL(String(u))).filter((u) => u.pathname === "/v1/organization/costs");
    expect(costCalls.map((u) => u.searchParams.get("page"))).toEqual([null, "cursor-2", "cursor-3"]);
    const first = costCalls[0].searchParams;
    expect(first.getAll("project_ids")).toEqual([PROJECT]);
    expect(first.get("start_time")).toBe(String(Date.UTC(2026, 9, 1) / 1000));
    expect(first.get("bucket_width")).toBe("1d");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN_KEY}`);
  });

  it("reports an error without the key or the provider body, and alerts once per outage", async () => {
    configure();
    costStatus = 500;
    const run = await runSpendMonitor(NOW);
    expect(run).toEqual({ status: "error", error: "costs_http_500" });
    await runSpendMonitor(NOW);
    expect(webhookEvents().filter((e) => e.event === "spend.monitor_error")).toHaveLength(1);
    expect(db.row?.tripped).toBe(false);
    expect(logs.join("\n")).not.toContain(ADMIN_KEY);
    expect(logs.join("\n")).not.toContain("secret detail");
  });
});

describe("not configured", () => {
  it("reports what is missing and does nothing", async () => {
    const run = await runSpendMonitor(NOW);
    expect(run).toEqual({ status: "not_configured", missing: ["DATABASE_URL", "OPENAI_ADMIN_KEY", "OPENAI_PROJECT_ID", "SPEND_BUDGET_START"], invalid: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes).toBe(0);
  });

  it("names invalid settings without their values", async () => {
    configure();
    vi.stubEnv("SPEND_BUDGET_USD", "lots");
    const run = await runSpendMonitor(NOW);
    expect(run).toMatchObject({ status: "not_configured", invalid: ["SPEND_BUDGET_USD"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cron route", () => {
  it("rejects a missing or wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", "right-secret");
    expect((await cronGET(cronReq())).status).toBe(401);
    expect((await cronGET(cronReq("Bearer wrong-secret"))).status).toBe(401);
    expect((await cronGET(cronReq("right-secret"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await cronGET(cronReq("Bearer "))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "right-secret");
    const off = await cronGET(cronReq("Bearer right-secret"));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, status: "not_configured" });

    configure();
    // The route runs on the real clock, so keep the credit unexpired whenever the suite runs.
    vi.stubEnv("SPEND_CREDIT_EXPIRES_AT", "2999-01-01T00:00:00Z");
    setCost(380);
    const res = await cronGET(cronReq("Bearer right-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "ok", periodCostUsd: 380, alerted: [50, 75] });
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });
});

describe("durable state reads", () => {
  it("fails closed when the database read fails, and caches briefly", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test");
    db.failRead = true;
    expect((await readSpendTrip(NOW)).tripped).toBe(true);
    expect((await paidFeaturesGuard(NOW))?.status).toBe(503);
    db.failRead = false;
    expect((await readSpendTrip(NOW + 1_000)).tripped).toBe(true); // still cached
    expect((await readSpendTrip(NOW + STATE_CACHE_MS)).tripped).toBe(false);
  });

  it("reads clear without a database", async () => {
    db.failRead = true;
    expect(await readSpendTrip(NOW)).toEqual({ tripped: false, dailyCapDay: null });
    expect(await paidFeaturesGuard(NOW)).toBeNull();
  });
});

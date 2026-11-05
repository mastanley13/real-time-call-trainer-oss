import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/** A tenant with access.mode "accounts_and_code": the access code is required, so a missing one must deny, not open. */
vi.mock("@/lib/tenant", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...m, tenant: { ...m.tenant, access: { ...m.tenant.access, mode: "accounts_and_code" } } };
});

import { middleware } from "@/middleware";
import { GET as healthGET } from "@/app/api/health/route";
import { POST as accessPOST } from "@/app/api/access/route";

const saved = { code: process.env.TRAINER_ACCESS_CODE, db: process.env.DATABASE_URL };
afterEach(() => {
  for (const [k, v] of [["TRAINER_ACCESS_CODE", saved.code], ["DATABASE_URL", saved.db]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const req = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost:3000${path}`, init);

describe("accounts_and_code without TRAINER_ACCESS_CODE", () => {
  it("denies pages and APIs, public ones included, and keeps health reachable", async () => {
    delete process.env.TRAINER_ACCESS_CODE;
    for (const p of ["/", "/login", "/library", "/access"]) {
      const res = await middleware(req(p));
      expect(res.status, p).toBe(503);
      expect(res.headers.get("location"), p).toBeNull();
    }
    for (const p of ["/api/config", "/api/access", "/api/auth/login"]) {
      const res = await middleware(req(p));
      expect(res.status, p).toBe(503);
      expect((await res.json()).error).toBe("access_code_not_configured");
    }
    expect((await middleware(req("/api/health"))).status).toBe(200);
  });

  it("reports unhealthy", async () => {
    delete process.env.TRAINER_ACCESS_CODE;
    delete process.env.DATABASE_URL;
    const res = await healthGET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.accessCode).toBe("missing");
  });

  it("refuses the access form instead of letting everyone in", async () => {
    delete process.env.TRAINER_ACCESS_CODE;
    const res = await accessPOST(req("/api/access", { method: "POST", body: JSON.stringify({ code: "" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(503);
  });
});

describe("accounts_and_code with TRAINER_ACCESS_CODE", () => {
  it("gates as usual and reports the code as configured", async () => {
    process.env.TRAINER_ACCESS_CODE = "letmein";
    expect((await middleware(req("/login"))).status).toBe(200);
    const res = await middleware(req("/library"));
    expect(res.status).toBe(307);
    delete process.env.DATABASE_URL;
    expect((await (await healthGET()).json()).checks.accessCode).toBe("ok");
  });

  it("sets the access cookie without a Domain attribute", async () => {
    process.env.TRAINER_ACCESS_CODE = "letmein";
    const res = await accessPOST(req("/api/access", { method: "POST", body: JSON.stringify({ code: "letmein" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/trainer_access=/);
    expect(cookie).not.toMatch(/domain=/i);
  });
});

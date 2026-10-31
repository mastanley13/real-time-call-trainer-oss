import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBootAllowed, getCapabilities, productionGuard } from "@/lib/serverConfig";

const DB = "postgresql://ci:ci@localhost:5432/ci";

describe("getCapabilities demoMode (fail closed)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const setEnv = (vars: Record<string, string>) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  };

  it("is false in production with DEMO_MODE=true and no opt-in", () => {
    setEnv({ NODE_ENV: "production", DEMO_MODE: "true" });
    expect(getCapabilities().demoMode).toBe(false);
  });

  it("is true in production with ALLOW_PUBLIC_DEMO=true", () => {
    setEnv({ NODE_ENV: "production", DEMO_MODE: "true", ALLOW_PUBLIC_DEMO: "true" });
    expect(getCapabilities().demoMode).toBe(true);
  });

  it("is true in development and false when DEMO_MODE is unset", () => {
    setEnv({ DEMO_MODE: "true" });
    expect(getCapabilities().demoMode).toBe(true);
    setEnv({ NODE_ENV: "production" });
    expect(getCapabilities().demoMode).toBe(false);
  });
});

describe("productionGuard", () => {
  it("blocks DEMO_MODE in production", () => {
    const env = { NODE_ENV: "production", DEMO_MODE: "true" };
    expect(productionGuard(env)).toEqual({ ok: false, problems: ["demo_in_production"] });
    expect(() => assertBootAllowed(env)).toThrow(/DEMO_MODE/);
  });

  it("allows DEMO_MODE in production with ALLOW_PUBLIC_DEMO=true", () => {
    const env = { NODE_ENV: "production", DEMO_MODE: "true", ALLOW_PUBLIC_DEMO: "true" };
    expect(productionGuard(env).ok).toBe(true);
    expect(() => assertBootAllowed(env)).not.toThrow();
  });

  it("does not accept other ALLOW_PUBLIC_DEMO values", () => {
    const env = { NODE_ENV: "production", DEMO_MODE: "true", ALLOW_PUBLIC_DEMO: "1" };
    expect(productionGuard(env).ok).toBe(false);
  });

  it("allows DEMO_MODE in development", () => {
    const env = { NODE_ENV: "development", DEMO_MODE: "true" };
    expect(productionGuard(env).ok).toBe(true);
    expect(() => assertBootAllowed(env)).not.toThrow();
  });

  it("allows production without demo when a database is set", () => {
    const env = { NODE_ENV: "production", DATABASE_URL: DB };
    expect(productionGuard(env)).toEqual({ ok: true, problems: [] });
    expect(() => assertBootAllowed(env)).not.toThrow();
  });

  it("flags a missing database in production without demo, without blocking boot", () => {
    const env = { NODE_ENV: "production" };
    expect(productionGuard(env)).toEqual({ ok: false, problems: ["database_missing"] });
    expect(() => assertBootAllowed(env)).not.toThrow();
  });
});

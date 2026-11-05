import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TenantConfigSchema, mergeTenantConfig, parseTenantJson } from "@/lib/tenant-schema";
import { legacyEnvOverlay, readContainedFile, redactSecrets, resolveTenantDir } from "@/lib/tenantBuild";
import { BUILT_IN_SCENARIOS, DataPersonaSchema, JOB_FAMILIES, ScenarioSchema, type Scenario } from "@/lib/scenarios";
import { OSS_PERSONAS } from "@/lib/personas";
import { personaProblems } from "@/lib/personaChecks";

/** Codex review of the tenant config: secret redaction, full persona rules, nested strict packs, link containment. */

const ROOT = process.cwd();
const DEFAULTS = TenantConfigSchema.parse(JSON.parse(readFileSync(join(ROOT, "tenants/calltrainer/tenant.json"), "utf8")));
const PNG = readFileSync(join(ROOT, "tenants/example/assets/mark.png"));
const EXAMPLE_PACK: Record<string, any>[] = JSON.parse(readFileSync(join(ROOT, "tenants/example/personas/field-service.json"), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Built at runtime so this file never contains a key-shaped literal. */
const FAKE_KEY = ["sk", "proj", "ZZfakeNotARealKey0123456789"].join("-");

const temps: string[] = [];
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));
const ACME = {
  schemaVersion: 1,
  id: "acme",
  brand: { name: "Acme Practice", shortName: "Acme", operatorName: "Acme Training (fictional)", supportEmail: "help@example.org", siteUrl: "https://acme.example.org", showOssSections: false },
};
function tempTenant(overlay: unknown, files: Record<string, Buffer | string> = {}): { base: string; dir: string } {
  const base = mkdtempSync(join(tmpdir(), "tenant-hard-"));
  temps.push(base);
  const dir = join(base, "acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tenant.json"), typeof overlay === "string" ? overlay : JSON.stringify(overlay));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { base, dir };
}
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a throw");
};

describe("finding 1: no supplied value or parser excerpt reaches an error message", () => {
  it("never echoes legacy env values", () => {
    for (const env of [{ NEXT_PUBLIC_BRAND_PRIMARY: FAKE_KEY }, { NEXT_PUBLIC_BRAND_PRIMARY_DARK: FAKE_KEY }, { NEXT_PUBLIC_BRAND_LOGO: FAKE_KEY }, { NEXT_PUBLIC_BRAND_LOGO: "https://cdn.example.org/x.png" }]) {
      const m = message(() => legacyEnvOverlay(env));
      expect(m).toMatch(/NEXT_PUBLIC_BRAND_(PRIMARY|PRIMARY_DARK|LOGO)/);
      expect(m).not.toContain(Object.values(env)[0]);
    }
  });

  it("refuses a secret-looking legacy env value before using it, naming only the variable", () => {
    const { dir } = tempTenant(ACME);
    const m = message(() => resolveTenantDir({ root: ROOT, dir, env: { NEXT_PUBLIC_BRAND_TAGLINE: FAKE_KEY } }));
    expect(m).toMatch(/NEXT_PUBLIC_BRAND_TAGLINE: looks like a secret/);
    expect(m).not.toContain(FAKE_KEY);
  });

  it("reports JSON syntax errors by position only", () => {
    const text = `{"brand": ${FAKE_KEY}}`;
    const m = message(() => parseTenantJson(text));
    expect(m).toMatch(/not valid JSON \(syntax error/);
    expect(m).not.toContain("sk-proj");
    expect(m).not.toContain("ZZfake");
  });

  it("scans tenant.json and pack files before parsing them, with labels only", () => {
    const inJson = tempTenant(`{"id": "acme", "brand": {"tagline": "${FAKE_KEY}"}, "oops"}`);
    const m1 = message(() => resolveTenantDir({ root: ROOT, dir: inJson.dir }));
    expect(m1).toMatch(/secret scan: tenant\.json: OpenAI-style key at line 1/);
    expect(m1).not.toContain(FAKE_KEY);

    const inPack = tempTenant({ ...ACME, personas: { packs: ["p1"], families: ["sdr"] } }, { "personas/p1.json": `[{"id": ${FAKE_KEY}` });
    const m2 = message(() => resolveTenantDir({ root: ROOT, dir: inPack.dir }));
    expect(m2).toMatch(/personas\.packs "p1": secret scan: OpenAI-style key/);
    expect(m2).not.toContain(FAKE_KEY);

    const badJson = tempTenant({ ...ACME, personas: { packs: ["p1"], families: ["sdr"] } }, { "personas/p1.json": "[{\"id\": nope" });
    const m3 = message(() => resolveTenantDir({ root: ROOT, dir: badJson.dir }));
    expect(m3).toMatch(/personas\.packs "p1": not valid JSON \(syntax error/);
    expect(m3).not.toContain("nope");
  });

  it("does not quote rejected enum, literal or type values", () => {
    const sneaky = "zzsupersecretvalue";
    for (const overlay of [{ access: { mode: sneaky } }, { schemaVersion: sneaky }, { voice: { defaultTier: sneaky } }, { access: { publicPaths: [sneaky] } }]) {
      const m = message(() => mergeTenantConfig(DEFAULTS, overlay));
      expect(m).toMatch(/expected/);
      expect(m).not.toContain(sneaky);
    }
  });

  it("redacts key-shaped strings from any printed text", () => {
    expect(redactSecrets(`oops ${FAKE_KEY} and postgresql://u:p@h/db`)).toBe("oops [redacted] and [redacted]");
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });

  it("does not echo TENANT_CONFIG_DIR", () => {
    const m = message(() => resolveTenantDir({ root: ROOT, dir: `tenants/${FAKE_KEY}` }));
    expect(m).toMatch(/TENANT_CONFIG_DIR has no tenant\.json/);
    expect(m).not.toContain(FAKE_KEY);
  });
});

describe("finding 2: the full persona rules run on every persona the tenant carries", () => {
  const ctx = { families: new Set([...JOB_FAMILIES.map((f) => f.id), "field-service"]), builtInIds: new Set(BUILT_IN_SCENARIOS.map((s) => s.id)) };
  const good = () => ScenarioSchema.parse(clone(EXAMPLE_PACK[0])) as Scenario;

  it("passes the OSS packs and the example data pack", () => {
    expect(personaProblems([...OSS_PERSONAS, good()], ctx).errors).toEqual([]);
  });

  it.each([
    ["an unknown family", (s: Scenario) => { s.role = "made-up"; s.id = "made-up-x"; }, /role "made-up" is not a JOB_FAMILIES/],
    ["weights that do not total 100", (s: Scenario) => { s.rubric[0].weight = 5; }, /rubric weights sum to 75, expected 100/],
    ["duplicate criterion ids", (s: Scenario) => { s.rubric[1].id = s.rubric[0].id; }, /duplicate rubric criterion ids/],
    ["an empty talk track", (s: Scenario) => { s.callScript = "  "; }, /empty talk track/],
    ["no objections", (s: Scenario) => { s.objections = []; }, /needs at least one objection/],
    ["an id without the family prefix", (s: Scenario) => { s.id = "boiler-callback"; }, /pack ids must start with the family id/],
  ])("fails a data pack persona with %s", (_label, mutate, re) => {
    const s = good();
    mutate(s);
    expect(personaProblems([s], ctx).errors.join("\n")).toMatch(re);
  });

  it("is what the prepare step runs, over ALL_PERSONAS, not only the filtered library", () => {
    const script = readFileSync(join(ROOT, "scripts/prepare-tenant.ts"), "utf8");
    expect(script).toMatch(/personaProblems\(ALL_PERSONAS,/);
    expect(script).toMatch(/\.\.\.checked\.errors/);
    expect(readFileSync(join(ROOT, "scripts/validate-personas.ts"), "utf8")).toMatch(/personaProblems\(ALL_PERSONAS,/);
  });
});

describe("finding 3: data packs are strict at every level", () => {
  const base = () => clone(EXAMPLE_PACK[0]);

  it("accepts the example pack and parses every OSS persona like ScenarioSchema", () => {
    expect(DataPersonaSchema.safeParse(base()).success).toBe(true);
    for (const s of OSS_PERSONAS) {
      const { builtIn: _b, ...plain } = s;
      void _b;
      expect(DataPersonaSchema.parse(plain), s.id).toEqual(ScenarioSchema.parse(plain));
    }
  });

  it.each([
    ["the persona", (p: Record<string, any>) => { p.extra = 1; }],
    ["aiPersona", (p: Record<string, any>) => { p.aiPersona.secretNotes = "x"; }],
    ["a rubric criterion", (p: Record<string, any>) => { p.rubric[0].hidden = true; }],
    ["an objection", (p: Record<string, any>) => { p.objections[0].internal = "x"; }],
  ])("rejects an unknown field on %s", (_label, mutate) => {
    const p = base();
    mutate(p);
    const r = DataPersonaSchema.safeParse(p);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    expect(ScenarioSchema.safeParse(p).success).toBe(true);
  });

  it("keeps ScenarioSchema's bounds", () => {
    const tooMany = base();
    tooMany.rubric = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, name: "C", description: "", weight: 1 }));
    expect(DataPersonaSchema.safeParse(tooMany).success).toBe(false);
    const noRubric = base();
    noRubric.rubric = [];
    expect(DataPersonaSchema.safeParse(noRubric).success).toBe(false);
    const objections = base();
    objections.objections = Array.from({ length: 9 }, () => clone(EXAMPLE_PACK[0].objections[0]));
    expect(DataPersonaSchema.safeParse(objections).success).toBe(false);
  });
});

describe("finding 4: no file outside the tenant directory is read through a link", () => {
  const withLogo = { ...ACME, brand: { ...ACME.brand, logo: { mark: "/tenant/mark.png", alt: "Acme" } } };
  const withPack = { ...ACME, personas: { packs: ["p1"], families: ["field-service"], customFamilies: [{ id: "field-service", label: "Field" }] } };

  it("fails closed on a linked assets folder", () => {
    const { base, dir } = tempTenant(withLogo);
    const outside = join(base, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "mark.png"), PNG);
    symlinkSync(outside, join(dir, "assets"), "dir");
    expect(() => resolveTenantDir({ root: ROOT, dir })).toThrow(/brand\.logo\.mark: assets must not be a link/);
  });

  it("fails closed on a linked personas folder", () => {
    const { base, dir } = tempTenant(withPack);
    const outside = join(base, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "p1.json"), JSON.stringify(EXAMPLE_PACK));
    symlinkSync(outside, join(dir, "personas"), "dir");
    expect(() => resolveTenantDir({ root: ROOT, dir })).toThrow(/personas\.packs "p1": personas must not be a link/);
  });

  it("fails closed on a linked file and a linked tenant.json", () => {
    const { base, dir } = tempTenant(withLogo);
    writeFileSync(join(base, "mark.png"), PNG);
    mkdirSync(join(dir, "assets"));
    symlinkSync(join(base, "mark.png"), join(dir, "assets", "mark.png"));
    expect(() => resolveTenantDir({ root: ROOT, dir })).toThrow(/assets\/mark\.png must not be a link/);

    const t = tempTenant(ACME);
    writeFileSync(join(t.base, "real.json"), JSON.stringify(ACME));
    rmSync(join(t.dir, "tenant.json"));
    symlinkSync(join(t.base, "real.json"), join(t.dir, "tenant.json"));
    expect(() => resolveTenantDir({ root: ROOT, dir: t.dir })).toThrow(/tenant\.json must not be a link/);
  });

  it("reads plain files inside the tenant directory", () => {
    const { dir } = tempTenant(withLogo, { "assets/mark.png": PNG });
    expect(readContainedFile(dir, ["assets", "mark.png"], 1024, "x").equals(PNG)).toBe(true);
    expect(resolveTenantDir({ root: ROOT, dir }).assets[0].data.equals(PNG)).toBe(true);
    expect(() => readContainedFile(dir, ["assets", "mark.png"], 10, "x")).toThrow(/over the 10 byte limit/);
  });
});

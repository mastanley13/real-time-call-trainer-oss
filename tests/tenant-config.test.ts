import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { brandCss, contrast, hexToRgb, themeContrastProblems } from "@/lib/brandCss";
import { THEME_TOKENS, TOKEN_NAMES } from "@/lib/themeTokens";
import {
  FEATURE_KEYS, PUBLIC_PATH_KEYS, TENANT_MAX_BYTES, TenantConfigSchema, mergeTenantConfig, parseTenantJson, type TenantConfig,
} from "@/lib/tenant-schema";
import {
  OSS_TENANT_IDS, legacyEnvOverlay, libraryProblems, listTenantDirs, resolveTenantDir, secretFieldFindings, secretFindings,
} from "@/lib/tenantBuild";
import { featureOn, storedOrDefaultTier, tenantIcons, tierToStore } from "@/lib/tenant";
import { effectiveVoiceTier } from "@/lib/voiceTier";
import { JOB_FAMILIES } from "@/lib/scenarios";
import { REALTIME_VOICES } from "@/lib/realtime";
import { OSS_PERSONAS, selectLibrary } from "@/lib/personas";
import { publicPathKeys, isPublicPath } from "@/lib/publicPaths";
import { accessGate } from "@/lib/access";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DEFAULTS = TenantConfigSchema.parse(JSON.parse(read("tenants/calltrainer/tenant.json")));
const EXAMPLE_OVERLAY = JSON.parse(read("tenants/example/tenant.json"));
const EXAMPLE = mergeTenantConfig(DEFAULTS, EXAMPLE_OVERLAY);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A throwaway tenant directory named after its id, so resolveTenantDir's id check passes. */
const temps: string[] = [];
function tempTenant(id: string, overlay: unknown, files: Record<string, Buffer | string> = {}): string {
  const base = mkdtempSync(join(tmpdir(), "tenant-test-"));
  temps.push(base);
  const dir = join(base, id);
  mkdirSync(join(dir, "assets"), { recursive: true });
  mkdirSync(join(dir, "personas"), { recursive: true });
  writeFileSync(join(dir, "tenant.json"), typeof overlay === "string" ? overlay : JSON.stringify(overlay));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));

const PNG = readFileSync(join(ROOT, "tenants/example/assets/mark.png"));
/** A valid non-default tenant overlay that every rejection test mutates. */
const ACME = {
  schemaVersion: 1,
  id: "acme",
  brand: { name: "Acme Practice", shortName: "Acme", operatorName: "Acme Training (fictional)", supportEmail: "help@example.org", siteUrl: "https://acme.example.org", showOssSections: false },
};
const resolveAcme = (mutate: (o: Record<string, any>) => void = () => {}, files: Record<string, Buffer | string> = {}, env: Record<string, string> = {}) => {
  const o: Record<string, any> = clone(ACME);
  mutate(o);
  return resolveTenantDir({ root: ROOT, dir: tempTenant(o.id ?? "acme", o, files), env });
};

describe("tenant schema", () => {
  it("parses the default and example tenants", () => {
    expect(DEFAULTS.id).toBe("calltrainer");
    expect(EXAMPLE.id).toBe("example");
    expect(() => resolveTenantDir({ root: ROOT })).not.toThrow();
    expect(() => resolveTenantDir({ root: ROOT, dir: "tenants/example" })).not.toThrow();
  });

  it("covers every feature and every public path entry in the default tenant", () => {
    expect(Object.keys(DEFAULTS.features).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(FEATURE_KEYS.every((k) => DEFAULTS.features[k])).toBe(true);
    expect([...DEFAULTS.access.publicPaths].sort()).toEqual([...PUBLIC_PATH_KEYS].sort());
  });

  it("rejects unknown and secret-named keys at every level", () => {
    for (const bad of [
      (c: Record<string, any>) => { c.extra = 1; },
      (c: Record<string, any>) => { c.brand.apiKey = "x"; },
      (c: Record<string, any>) => { c.features.stripeSecret = false; },
      (c: Record<string, any>) => { c.access.code = "letmein"; },
      (c: Record<string, any>) => { c.copy.landing.token = "x"; },
      (c: Record<string, any>) => { c.personas.customFamilies = [{ id: "x-y", label: "X", password: "p" }]; },
    ]) {
      const c = clone(DEFAULTS) as Record<string, any>;
      bad(c);
      expect(TenantConfigSchema.safeParse(c).success).toBe(false);
    }
    expect(secretFieldFindings({ brand: { apiKey: "x" }, access: { code: "y" } })).toHaveLength(2);
  });

  it.each(["#FFF", "#GGGGGG", "#9A3412", "9a3412", "red", "#9a34120"])("rejects the color %s", (hex) => {
    expect(() => mergeTenantConfig(DEFAULTS, { theme: { primary: hex } })).toThrow(/theme\.primary/);
  });

  it.each([
    "https://cdn.example.org/mark.png", "//evil.example.org/a.png", "/tenant/../secret.png", "/tenant/a..png",
    "/tenant/mark.svg", "/brand/mark.png", "/tenant/sub/mark.png", "/tenant/mark.PNG.exe",
  ])("rejects the asset path %s", (path) => {
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { logo: { mark: path, alt: "Mark" } } })).toThrow(/brand\.logo\.mark/);
  });

  it("rejects a missing, oversize, linked or fake asset file", () => {
    const withLogo = (o: Record<string, any>) => { o.brand.logo = { mark: "/tenant/mark.png", alt: "Acme" }; };
    expect(() => resolveAcme(withLogo)).toThrow(/brand\.logo\.mark: assets\/mark\.png not found in the tenant directory/);
    expect(() => resolveAcme(withLogo, { "assets/mark.png": Buffer.alloc(600 * 1024, 1) })).toThrow(/over the 524288 byte limit/);
    expect(() => resolveAcme(withLogo, { "assets/mark.png": "<svg></svg>" })).toThrow(/not a real \.png file/);
    expect(resolveAcme(withLogo, { "assets/mark.png": PNG }).assets.map((a) => a.name)).toEqual(["mark.png"]);
  });

  it.each([
    ["markup", "<b>Hi</b>"], ["a URL", "Visit https://example.org"], ["a domain", "See acme.com today"], ["an em dash", "Practice — now"],
    ["a line break", "One\nTwo"],
  ])("rejects copy with %s", (_label, text) => {
    expect(() => mergeTenantConfig(DEFAULTS, { copy: { landing: { headline: text } } })).toThrow(/copy\.landing\.headline/);
  });

  const MODEL_IDS = [
    "gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini-transcribe", "GPT-5",
    "gpt-4", "gpt-4-turbo", "gpt-4-0613", "gpt-4.5-preview", "gpt-3.5-turbo",
    "o3-mini", "o4-mini", "whisper-1", "tts-1-hd", "claude-sonnet-4-5", "gemini-2.5-flash", "eleven_turbo_v2_5",
  ];
  /** Every copy slot a tenant can fill, as an overlay builder. */
  const COPY_SLOTS: [string, (t: string) => Record<string, unknown>][] = [
    ["brand.tagline", (t) => ({ brand: { tagline: `Powered by ${t}` } })],
    ["brand.name", (t) => ({ brand: { name: `Desk ${t}` } })],
    ["brand.shortName", (t) => ({ brand: { shortName: t } })],
    ["brand.operatorName", (t) => ({ brand: { operatorName: `${t} Labs` } })],
    ["brand.disclaimer", (t) => ({ brand: { disclaimer: `Coach runs on ${t}.` } })],
    ["brand.logo.alt", (t) => ({ brand: { logo: { mark: "/tenant/mark.png", alt: t } } })],
    ["copy.landing.eyebrow", (t) => ({ copy: { landing: { eyebrow: t } } })],
    ["copy.landing.headline", (t) => ({ copy: { landing: { headline: `Practise with ${t}` } } })],
    ["copy.landing.subhead", (t) => ({ copy: { landing: { subhead: `Voice by ${t}, coach by us.` } } })],
    ["copy.landing.featureBlurb", (t) => ({ copy: { landing: { featureBlurb: t } } })],
    ["copy.library.intro", (t) => ({ copy: { library: { intro: t } } })],
    ["copy.library.draftBanner", (t) => ({ copy: { library: { draftBanner: t } } })],
    ["copy.wizard.shareLine", (t) => ({ copy: { wizard: { shareLine: t } } })],
    ["copy.team.noOrg", (t) => ({ copy: { team: { noOrg: t } } })],
    ["copy.team.inviteHelp", (t) => ({ copy: { team: { inviteHelp: t } } })],
    ["copy.meta.description", (t) => ({ copy: { meta: { description: `Built on ${t}.` } } })],
    ["personas.customFamilies.0.label", (t) => ({ personas: { customFamilies: [{ id: "field-ops", label: t }] } })],
  ];

  it.each(COPY_SLOTS.flatMap(([key, build]) => MODEL_IDS.map((id) => [key, id, build] as const)))(
    "rejects a model name in %s (%s)",
    (key, id, build) => {
      let message = "";
      try {
        mergeTenantConfig(DEFAULTS, build(id));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`${key}: no model names in copy`);
      // The error names the field, never the value.
      expect(message).not.toContain(id);
    },
  );

  it.each(["gpt-realtime", "gpt-4o", "claude-sonnet"])("rejects the terminology noun %s", (noun) => {
    expect(() => mergeTenantConfig(DEFAULTS, { copy: { terminology: { trainee: noun } } })).toThrow(/copy\.terminology\.trainee: no model names in copy/);
  });

  it("accepts neutral copy that mentions AI, providers or similar words", () => {
    const ok = {
      brand: { tagline: "Practise with an AI coach", disclaimer: "Voice by OpenAI Realtime or ElevenLabs. Your chat model grades the call." },
      copy: {
        landing: { headline: "Five calls, one coach", subhead: "Model answers for every objection, scored in real time.", eyebrow: "GPT style practice, no setup" },
        library: { intro: "Claude, Gemini and Eleven are persona names, not models." },
        terminology: { trainee: "rep", customer: "buyer", team: "team", manager: "manager" },
      },
    };
    expect(() => mergeTenantConfig(DEFAULTS, ok)).not.toThrow();
  });

  it("rejects an oversize file, a bad id and non-https or path-bearing URLs", () => {
    expect(() => parseTenantJson(JSON.stringify({ pad: "x".repeat(TENANT_MAX_BYTES) }))).toThrow(/larger than/);
    expect(() => parseTenantJson("[1,2]")).toThrow(/JSON object/);
    expect(() => parseTenantJson("{nope")).toThrow(/not valid JSON/);
    for (const id of ["A", "Bad_ID", "-x", "x-", "a".repeat(41)]) expect(() => mergeTenantConfig(DEFAULTS, { id })).toThrow(/id/);
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { siteUrl: "http://acme.example.org" } })).toThrow(/https only/);
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { siteUrl: "https://acme.example.org/app" } })).toThrow(/origin only/);
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { upstreamUrl: "javascript:alert(1)" } })).toThrow(/brand\.upstreamUrl/);
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { supportEmail: "not-an-email" } })).toThrow(/brand\.supportEmail/);
  });

  it("does not offer a public demo access mode, and the access code never comes from config", () => {
    expect(() => mergeTenantConfig(DEFAULTS, { access: { mode: "public_demo" } })).toThrow(/access\.mode/);
    expect(() => mergeTenantConfig(DEFAULTS, { access: { publicPaths: ["/dashboard"] } })).toThrow(/access\.publicPaths/);
    expect(() => mergeTenantConfig(DEFAULTS, { access: { publicPaths: ["/login", "/login"] } })).toThrow(/duplicate/);
  });

  it("makes a non-default tenant set its own name, operator, support address and site", () => {
    expect(() => resolveAcme((o) => { delete o.brand.supportEmail; })).toThrow(/brand\.supportEmail: a tenant must set its own value/);
    expect(() => resolveAcme((o) => { delete o.brand.operatorName; })).toThrow(/brand\.operatorName/);
    expect(() => resolveAcme((o) => { o.id = "other"; }, {})).not.toThrow();
  });

  it("requires the tenant id to match its directory", () => {
    const dir = tempTenant("wrong-dir", ACME);
    expect(() => resolveTenantDir({ root: ROOT, dir })).toThrow(/must match the tenant directory name "wrong-dir"/);
  });

  it("fails when TENANT_CONFIG_DIR has no tenant.json, instead of falling back to the default", () => {
    expect(() => resolveTenantDir({ root: ROOT, dir: "tenants/does-not-exist" })).toThrow(/has no tenant\.json/);
  });
});

describe("mergeTenantConfig", () => {
  it("merges objects deeply and replaces arrays and scalars", () => {
    const m = mergeTenantConfig(DEFAULTS, { brand: { tagline: "Hello there" }, personas: { families: ["sdr"] }, features: { pricing: false } });
    expect(m.brand.name).toBe(DEFAULTS.brand.name);
    expect(m.brand.tagline).toBe("Hello there");
    expect(m.personas.families).toEqual(["sdr"]);
    expect(m.personas.packs).toEqual(DEFAULTS.personas.packs);
    expect(m.features.pricing).toBe(false);
    expect(m.features.billing).toBe(true);
    expect(DEFAULTS.personas.families.length).toBeGreaterThan(1);
  });

  it("rejects __proto__, constructor and prototype keys before merging", () => {
    for (const text of ['{"__proto__":{"polluted":true}}', '{"brand":{"constructor":{"x":1}}}', '{"copy":{"prototype":1}}']) {
      expect(() => mergeTenantConfig(DEFAULTS, JSON.parse(text))).toThrow(/is not allowed/);
      expect(() => parseTenantJson(text)).toThrow(/is not allowed/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates the merged result again and caps the input", () => {
    expect(() => mergeTenantConfig(DEFAULTS, { brand: { poweredBy: "yes" } })).toThrow(/brand\.poweredBy/);
    expect(() => mergeTenantConfig(DEFAULTS, { brand: null })).toThrow(/brand/);
    expect(() => mergeTenantConfig(DEFAULTS, { copy: { library: { intro: "x".repeat(TENANT_MAX_BYTES) } } })).toThrow(/limit is 65536/);
  });

  it("is idempotent", () => {
    const once = mergeTenantConfig(DEFAULTS, EXAMPLE_OVERLAY);
    expect(mergeTenantConfig(once, EXAMPLE_OVERLAY)).toEqual(once);
    expect(mergeTenantConfig(DEFAULTS, DEFAULTS)).toEqual(DEFAULTS);
  });
});

describe("default-tenant parity (calltrainer.tech unchanged)", () => {
  it("keeps the brand, contact and site values", () => {
    expect(DEFAULTS.brand).toMatchObject({
      name: "Real-Time Call Trainer", shortName: "Call Trainer", operatorName: "StrategixAI LLC", supportEmail: "support@calltrainer.tech",
      siteUrl: "https://calltrainer.tech", upstreamUrl: "https://github.com/mastanley13/real-time-call-trainer-oss", poweredBy: false, showOssSections: true,
    });
    expect(DEFAULTS.brand.logo).toBeUndefined();
    expect(DEFAULTS.access.mode).toBe("accounts");
    expect(DEFAULTS.voice.defaultTier).toBe("standard");
  });

  it("emits no brand CSS", () => {
    expect(brandCss(DEFAULTS.theme.primary, DEFAULTS.theme.primaryDark)).toBe("");
  });

  it("offers exactly today's library, in order", () => {
    const ids = JSON.parse(read("tests/fixtures/calltrainer-library-ids.json"));
    expect(selectLibrary(DEFAULTS.personas, OSS_PERSONAS, []).map((s) => s.id)).toEqual(ids);
    expect(DEFAULTS.personas.families).toEqual(JOB_FAMILIES.map((f) => f.id));
  });

  it("keeps every OSS public path", () => {
    expect(publicPathKeys(DEFAULTS)).toEqual(DEFAULTS.access.publicPaths);
  });

  it("leaves the tab icon to src/app/icon.svg (content-hashed App Router icon), as on main", () => {
    expect(DEFAULTS.brand.icon).toBeUndefined();
    expect(DEFAULTS.brand.favicon).toBeUndefined();
    // Next uses the file convention only while metadata.icons is unset.
    expect(tenantIcons(DEFAULTS.brand)).toBeUndefined();
    expect(statSync(join(ROOT, "src/app/icon.svg")).isFile()).toBe(true);
    // A second copy in public/ would be served as a plain static file at the same path.
    expect(() => statSync(join(ROOT, "public/icon.svg"))).toThrow();
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("tenantIcons()");
    expect(layout).toContain("...(ICONS ? { icons: ICONS } : {})");
    expect(layout).not.toContain('"/icon.svg"');
  });
});

describe("tenant tab icons", () => {
  it("uses brand.icon as the tab icon, replacing the stock icon", () => {
    expect(tenantIcons({ icon: "/tenant/mark.png" })).toEqual({ icon: [{ url: "/tenant/mark.png" }] });
    expect(tenantIcons(EXAMPLE.brand)).toEqual({ icon: [{ url: "/tenant/mark.png" }] });
  });

  it("adds brand.favicon as the shortcut icon, keeping the stock icon when brand.icon is unset", () => {
    expect(tenantIcons({ icon: "/tenant/tab.png", favicon: "/tenant/favicon.ico" })).toEqual({
      icon: [{ url: "/tenant/tab.png" }],
      shortcut: [{ url: "/tenant/favicon.ico" }],
    });
    expect(tenantIcons({ favicon: "/tenant/favicon.ico" })).toEqual({
      icon: [{ url: "/icon.svg", type: "image/svg+xml", sizes: "any" }],
      shortcut: [{ url: "/tenant/favicon.ico" }],
    });
  });
});

describe("legacy env shim (deprecated)", () => {
  it("maps each NEXT_PUBLIC_BRAND_* and NEXT_PUBLIC_PERSONA_FAMILIES like the AirPets brand layer", () => {
    const { overlay, used } = legacyEnvOverlay({
      NEXT_PUBLIC_BRAND_NAME: " Acme Moving ", NEXT_PUBLIC_BRAND_TAGLINE: "Acme Moving · advisor training", NEXT_PUBLIC_BRAND_LOGO: "/tenant/mark.png",
      NEXT_PUBLIC_BRAND_PRIMARY: "00455B", NEXT_PUBLIC_BRAND_PRIMARY_DARK: "#5CC6DD", NEXT_PUBLIC_PERSONA_FAMILIES: "sdr, ae,",
    });
    expect(used).toHaveLength(6);
    expect(overlay).toEqual({
      brand: { name: "Acme Moving", shortName: "Acme Moving", showOssSections: false, poweredBy: true, tagline: "Acme Moving · advisor training", logo: { mark: "/tenant/mark.png", alt: "Acme Moving logo" } },
      theme: { primary: "#00455b", primaryDark: "#5cc6dd" },
      personas: { families: ["sdr", "ae"] },
    });
    expect(legacyEnvOverlay({ NEXT_PUBLIC_BRAND_NAME: "Acme", NEXT_PUBLIC_BRAND_SHORT_NAME: "AM" }).overlay).toMatchObject({ brand: { name: "Acme", shortName: "AM" } });
  });

  it("ignores blank variables and refuses unusable values with the variable name", () => {
    expect(legacyEnvOverlay({ NEXT_PUBLIC_BRAND_NAME: "  ", NEXT_PUBLIC_PERSONA_FAMILIES: " , " })).toEqual({ overlay: {}, used: [] });
    expect(() => legacyEnvOverlay({ NEXT_PUBLIC_BRAND_LOGO: "https://cdn.example.org/x.png" })).toThrow(/NEXT_PUBLIC_BRAND_LOGO/);
    expect(() => legacyEnvOverlay({ NEXT_PUBLIC_BRAND_PRIMARY: "teal" })).toThrow(/NEXT_PUBLIC_BRAND_PRIMARY/);
  });

  it("beats tenant.json, and warns that it is deprecated", () => {
    const r = resolveAcme((o) => { o.brand.tagline = "From the file"; }, {}, { NEXT_PUBLIC_BRAND_TAGLINE: "From the env", NEXT_PUBLIC_PERSONA_FAMILIES: "sdr" });
    expect(r.config.brand.tagline).toBe("From the env");
    expect(r.config.personas.families).toEqual(["sdr"]);
    expect(r.warnings.join(" ")).toMatch(/NEXT_PUBLIC_BRAND_TAGLINE is deprecated/);
  });

  it("does not let env override what the runtime owns: APP_URL still beats brand.siteUrl", async () => {
    const { siteUrl } = await import("@/lib/seo");
    const prev = process.env.APP_URL;
    process.env.APP_URL = "https://override.example.org/x";
    try {
      expect(siteUrl()).toBe("https://override.example.org");
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });
});

describe("fail closed", () => {
  it("never turns a feature on without its capability", () => {
    for (const k of FEATURE_KEYS) {
      expect(featureOn(k, false, DEFAULTS)).toBe(false);
      expect(featureOn(k, true, DEFAULTS)).toBe(true);
    }
    expect(featureOn("billing", true, EXAMPLE)).toBe(false);
    expect(featureOn("googleSignIn", true, EXAMPLE)).toBe(false);
  });

  it("keeps the voice quality panel hidden while realtime is off, whatever the config says", () => {
    expect(featureOn("voiceQualityPanel", false, DEFAULTS)).toBe(false);
    expect(featureOn("voiceQualityPanel", false, EXAMPLE)).toBe(false);
  });

  it("only fills a null tier with voice.defaultTier, and Premium still needs comped", () => {
    const premium = mergeTenantConfig(DEFAULTS, { voice: { defaultTier: "premium" } });
    expect(storedOrDefaultTier(null, premium)).toBe("premium");
    expect(storedOrDefaultTier("", premium)).toBe("premium");
    expect(storedOrDefaultTier("standard", premium)).toBe("standard");
    expect(effectiveVoiceTier(storedOrDefaultTier(null, premium), null)).toBe("standard");
    expect(effectiveVoiceTier(storedOrDefaultTier(null, premium), false)).toBe("standard");
    expect(effectiveVoiceTier(storedOrDefaultTier(null, premium), true)).toBe("premium");
    expect(effectiveVoiceTier(storedOrDefaultTier(null, DEFAULTS), true)).toBe("standard");
  });

  it("stores an explicit Standard choice so a Premium default cannot fill it back in", () => {
    const premium = mergeTenantConfig(DEFAULTS, { voice: { defaultTier: "premium" } });
    expect(tierToStore("standard", DEFAULTS)).toBeNull();
    expect(tierToStore("premium", DEFAULTS)).toBe("premium");
    expect(tierToStore("standard", premium)).toBe("standard");
    expect(effectiveVoiceTier(storedOrDefaultTier(tierToStore("standard", premium), premium), true)).toBe("standard");
  });

  it("fails the build when the family filter is empty or matches nothing", () => {
    expect(() => mergeTenantConfig(DEFAULTS, { personas: { families: [] } })).toThrow(/at least one job family/);
    expect(() => selectLibrary({ ...DEFAULTS.personas, families: ["no-such-family"] }, OSS_PERSONAS, [])).toThrow(/matches no persona/);
    expect(() => selectLibrary({ ...DEFAULTS.personas, includeOssPacks: false }, OSS_PERSONAS, [])).toThrow(/matches no persona/);
    const ctx = { ossFamilyIds: JOB_FAMILIES.map((f) => f.id), voices: REALTIME_VOICES, libraryIds: [] };
    expect(libraryProblems(DEFAULTS, ctx)).toContain("personas.families: the filter matches no persona");
  });

  it("puts the access gate in a deny state for accounts_and_code without a code", () => {
    expect(accessGate("accounts_and_code", null)).toBe("misconfigured");
    expect(accessGate("accounts", null)).toBe("off");
    expect(accessGate("accounts_and_code", "letmein")).toEqual({ code: "letmein" });
  });
});

describe("personas from tenant config", () => {
  const oss = OSS_PERSONAS;
  it("hides drafts when showDrafts is off and never marks a data pack persona reviewed", () => {
    const reviewedOnly = selectLibrary({ ...DEFAULTS.personas, showDrafts: false }, oss, []);
    expect(reviewedOnly.length).toBeGreaterThan(0);
    expect(reviewedOnly.every((s) => s.status === "reviewed")).toBe(true);
    const r = resolveTenantDir({ root: ROOT, dir: "tenants/example" });
    expect(r.personas.length).toBeGreaterThan(0);
    expect(r.personas.every((p) => (p as { status: string }).status === "draft")).toBe(true);
    const unlabeled = resolveAcme((o) => { o.personas = { packs: ["p1"], families: ["sdr"] }; }, {
      "personas/p1.json": JSON.stringify([{ ...(r.personas[0] as object), id: "sdr-x", role: "sdr", status: undefined }]),
    });
    expect((unlabeled.personas[0] as { status: string }).status).toBe("draft");
  });

  it("checks tenant families, the default persona and the default voice", () => {
    const ctx = { ossFamilyIds: JOB_FAMILIES.map((f) => f.id), voices: REALTIME_VOICES, libraryIds: ["sdr-a"] };
    const bad = mergeTenantConfig(DEFAULTS, {
      personas: { families: ["sdr", "made-up"], customFamilies: [{ id: "sdr", label: "Clash" }], defaultScenarioId: "missing" },
      voice: { defaultVoice: "robot" },
    });
    const problems = libraryProblems(bad, ctx).join("\n");
    expect(problems).toMatch(/customFamilies: "sdr" is already an OSS job family/);
    expect(problems).toMatch(/families: "made-up" is not a job family id/);
    expect(problems).toMatch(/defaultScenarioId: "missing"/);
    expect(problems).toMatch(/defaultVoice: "robot"/);
    expect(libraryProblems(EXAMPLE, { ...ctx, libraryIds: ["field-service-boiler-callback"] })).toEqual([]);
  });

  it("selects OSS families plus the example data pack, data packs last", () => {
    const r = resolveTenantDir({ root: ROOT, dir: "tenants/example" });
    const data = r.personas.map((p) => ({ ...(p as object), builtIn: true })) as typeof oss;
    const lib = selectLibrary(r.config.personas, oss, data);
    expect(new Set(lib.map((s) => s.role))).toEqual(new Set(["sdr", "cs", "home-services", "field-service"]));
    expect(lib[lib.length - 1].id).toBe("field-service-boiler-callback");
    expect(() => selectLibrary(r.config.personas, oss, [...data, ...data])).toThrow(/Duplicate persona id/);
  });

  it("rejects a pack file that is missing, not an array, too large or carries forbidden keys", () => {
    const withPack = (o: Record<string, any>) => { o.personas = { packs: ["p1"], families: ["sdr"] }; };
    expect(() => resolveAcme(withPack)).toThrow(/personas\.packs "p1": personas\/p1\.json not found in the tenant directory/);
    expect(() => resolveAcme(withPack, { "personas/p1.json": "{}" })).toThrow(/non-empty JSON array/);
    expect(() => resolveAcme(withPack, { "personas/p1.json": '[{"__proto__":{}}]' })).toThrow(/is not allowed/);
    expect(() => resolveAcme(withPack, { "personas/p1.json": `[${"1,".repeat(200 * 1024)}1]` })).toThrow(/byte limit/);
  });
});

describe("contrast", () => {
  it("passes the example tenant and fails low-contrast colors, naming the key", () => {
    expect(themeContrastProblems(EXAMPLE.theme)).toEqual([]);
    expect(themeContrastProblems({ primary: "#ffff00" }).join("\n")).toMatch(/^theme\.primary: primary against the daylight background/m);
    expect(themeContrastProblems({ primary: "#9a3412", primaryDark: "#1e1b4b" }).join("\n")).toMatch(/^theme\.primaryDark: primary against the dark theme and call deck background/m);
    expect(() => resolveAcme((o) => { o.theme = { primary: "#ffff00" }; })).toThrow(/theme\.primary: /);
  });

  it("checks button text at 4.5:1 and UI fills at 3:1", () => {
    const mid = "#808080";
    const problems = themeContrastProblems({ primary: mid });
    for (const p of problems) expect(p).toMatch(/below (4\.5|3):1/);
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
  });
});

describe("brand CSS", () => {
  const tokenIn = (css: string, rule: string, token: string) => {
    const body = css.slice(css.indexOf(rule)).split("}")[0];
    return new RegExp(`--${token}:(\\d+ \\d+ \\d+)`).exec(body)?.[1];
  };

  it("parses #rrggbb with or without the hash and rejects anything else", () => {
    expect(hexToRgb("#00455B")).toEqual([0, 69, 91]);
    for (const bad of ["", "#fff", "red", "#00455", "#00455BZ", undefined]) expect(hexToRgb(bad)).toBeNull();
  });

  it("overrides the light, dark, deck and print tokens with selectors that outrank globals.css", () => {
    const css = brandCss("#00455b", "#5cc6dd");
    expect(tokenIn(css, "html:root{", "primary")).toBe("0 69 91");
    expect(tokenIn(css, 'html .deck,html:root[data-theme="dark"]{', "primary")).toBe("92 198 221");
    expect(css.lastIndexOf("@media print")).toBeGreaterThan(css.lastIndexOf("prefers-color-scheme"));
    expect(tokenIn(css, 'html .deck,html:root[data-theme="dark"]{', "on-primary")).toBe(THEME_TOKENS.light.ink.join(" "));
  });

  it("reads its base tokens from one table that matches globals.css", () => {
    const css = read("src/app/globals.css");
    const block = (re: RegExp) => re.exec(css)?.[1] ?? "";
    const blocks = {
      light: block(/:root\s*\{([^}]*)\}/),
      dark: block(/\.deck,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
      prefers: block(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
    };
    for (const [scheme, body] of Object.entries(blocks)) {
      const table = THEME_TOKENS[scheme === "light" ? "light" : "dark"];
      for (const name of TOKEN_NAMES) {
        const m = new RegExp(`--${name}:\\s*(\\d+ \\d+ \\d+);`).exec(body);
        expect(m?.[1], `${scheme} --${name}`).toBe(table[name].join(" "));
      }
    }
  });
});

describe("repository hygiene", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

  it("holds only the calltrainer and example tenants (client tenants live in a private deploy repo)", () => {
    expect(listTenantDirs(ROOT)).toEqual([...OSS_TENANT_IDS]);
    expect(readdirSync(join(ROOT, "tenants"))).toEqual([...OSS_TENANT_IDS]);
  });

  it("finds no secrets in tenants/** or in the generated config", () => {
    const targets = [...files(join(ROOT, "tenants")), join(ROOT, "src/generated/tenant.json"), join(ROOT, "src/generated/tenant-personas.json")];
    for (const f of targets) {
      const rel = relative(ROOT, f).split(sep).join("/");
      if (/\.(png|ico|webp)$/.test(f)) {
        expect(statSync(f).size, rel).toBeLessThanOrEqual(512 * 1024);
        continue;
      }
      expect(f.endsWith(".json"), `${rel} must be JSON data`).toBe(true);
      const text = readFileSync(f, "utf8");
      expect(secretFindings(text), rel).toEqual([]);
      expect(secretFieldFindings(JSON.parse(text)), rel).toEqual([]);
    }
  });

  it("catches key-shaped strings", () => {
    const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    for (const s of ["sk-proj-abcdefghijklmnopqrstuv", "sk_test_abcdefgh123", "ek_abcdefghijk", pem, "postgresql://u:p@h/db", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlLXg", "ghp_abcdefghijklmnopqrstuvwx"]) {
      expect(secretFindings(`"x": "${s}"`), s).not.toEqual([]);
    }
  });

  it("keeps generated tenant output out of git", () => {
    const ignore = read(".gitignore");
    expect(ignore).toMatch(/^\/src\/generated\/\*$/m);
    expect(ignore).toMatch(/^\/public\/tenant\/$/m);
  });

  it("sets no Domain attribute on auth or access cookies", () => {
    const src = files(join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    const hits = src.flatMap((f) => (/cookies\.set\([^)]*domain\s*:/i.test(readFileSync(f, "utf8")) ? [relative(ROOT, f)] : []));
    expect(hits).toEqual([]);
  });
});

describe("public paths per tenant", () => {
  it("narrows to the tenant subset and drops the landing pages when publicLanding is off", () => {
    const keys = publicPathKeys(EXAMPLE);
    expect(keys).not.toContain("/");
    expect(isPublicPath("/", keys)).toBe(false);
    expect(isPublicPath("/pricing", keys)).toBe(false);
    expect(isPublicPath("/login", keys)).toBe(true);
    expect(isPublicPath("/for/solar/opengraph-image", keys)).toBe(false);
    expect(isPublicPath("/opengraph-image", keys)).toBe(true);
    const noLanding = mergeTenantConfig(DEFAULTS, { features: { publicLanding: false } });
    expect(publicPathKeys(noLanding)).not.toContain("/for/*");
    expect(publicPathKeys(noLanding)).not.toContain("/");
  });

  it("matches the landing and legal pages exactly, as the middleware did", () => {
    expect(isPublicPath("/privacy", DEFAULTS.access.publicPaths)).toBe(true);
    expect(isPublicPath("/privacy/", DEFAULTS.access.publicPaths)).toBe(false);
    expect(isPublicPath("/privacy/evil", DEFAULTS.access.publicPaths)).toBe(false);
  });
});

describe("example tenant assets", () => {
  it("copies only referenced assets", () => {
    const r = resolveTenantDir({ root: ROOT, dir: "tenants/example" });
    expect(r.assets.map((a) => a.name)).toEqual(["mark.png"]);
    const out = mkdtempSync(join(tmpdir(), "tenant-assets-"));
    temps.push(out);
    for (const a of r.assets) writeFileSync(join(out, a.name), a.data);
    expect(r.assets[0].data.equals(PNG)).toBe(true);
    expect(readdirSync(out)).toEqual(["mark.png"]);
  });
});

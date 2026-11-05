/**
 * Tenant config schema v1 and the pure merge. A tenant is a directory with tenant.json (data only) and assets/;
 * see docs/TENANTS.md. tenants/calltrainer/tenant.json is the full default; any other tenant.json is a partial overlay
 * merged on top of it, and the merged result is parsed again with the strict schema below.
 *
 * Rules: every object is .strict() (unknown keys fail), nothing here can hold a secret (keys, codes and URLs of
 * private services stay in the environment), and config can only hide, rename or select. It never grants: features
 * are ANDed with the runtime capability, and the voice tier still needs the database comped flag.
 *
 * Pure and client-safe (zod only). Checks that need the file system, the persona library or the voice list live in
 * src/lib/tenantBuild.ts and run in the prebuild.
 */
import { z } from "zod";
import { hasModelId } from "./modelIds";

export const TENANT_SCHEMA_VERSION = 1;
/** tenant.json and the merge input are capped at 64 KiB. */
export const TENANT_MAX_BYTES = 64 * 1024;
export const DEFAULT_TENANT_ID = "calltrainer";

/** Each feature can only be switched OFF by config. On means "allowed"; the runtime capability still has to be there. */
export const FEATURE_KEYS = [
  "pricing", "billing", "googleSignIn", "wizard", "urlImport", "teamView", "invites", "voiceQualityPanel", "commandPalette", "publicLanding",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * The OSS public-path allowlist, as named entries a tenant may keep or drop (access.publicPaths). The access gate's own
 * endpoints, /api/health, cron and the Stripe webhook are always reachable and are not listed here.
 */
export const PUBLIC_PATH_KEYS = [
  "/", "/privacy", "/terms", "/pricing", "/register", "/login", "/auth/complete", "/robots.txt", "/sitemap.xml",
  "/for/*", "/opengraph-image", "/api/auth/*",
] as const;
export type PublicPathKey = (typeof PUBLIC_PATH_KEYS)[number];

/** "public_demo" is deliberately not offered: demo mode stays an env decision with its own production guard. */
export const ACCESS_MODES = ["accounts", "accounts_and_code"] as const;
export const VOICE_TIER_IDS = ["standard", "premium"] as const;
export const VOICE_ENGINE_IDS = ["openai", "elevenlabs"] as const;

/** Keys rejected anywhere in tenant input before merging. */
export const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"] as const;

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HEX = /^#[0-9a-f]{6}$/;
/** Local asset under /tenant/: one file name, PNG, ICO or WebP. SVG is excluded in v1. */
const ASSET = /^\/tenant\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|ico|webp)$/;
const URLISH = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|tech|co|app|dev|ai|us|uk|gov|mil|edu|info|biz)\b)/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

const slug = (min: number, max: number) =>
  z.string().min(min).max(max).regex(SLUG, "use lowercase letters, digits and single hyphens");

/** Copy names no model: the same families tests/no-model-labels.test.ts keeps off every page. The value is never echoed. */
const NO_MODEL_NAMES = "no model names in copy";

/** Copy is rendered as text: no markup, no URLs, no em dashes, no control characters, no model names. */
export const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("<") && !v.includes(">"), "plain text only, no < or >")
    .refine((v) => !v.includes("—"), "no em dashes")
    .refine((v) => !URLISH.test(v), "no URLs or domain names in copy")
    .refine((v) => !CONTROL.test(v), "no control characters or line breaks")
    .refine((v) => !hasModelId(v), NO_MODEL_NAMES);

const assetPath = z
  .string()
  .max(120)
  .regex(ASSET, "must be /tenant/<file>.png, .ico or .webp (no SVG, no remote URLs)")
  .refine((v) => !v.includes("..") && !v.slice(1).includes("//"), "no .. or //");

const httpsUrl = z
  .string()
  .max(200)
  .url()
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "https only");

const origin = httpsUrl.refine((v) => {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}, "an origin only, like https://example.com (no path, query or trailing slash)");

/** A noun used where the UI already has a slot, such as "rep" or "recruiter". Lowercase words only. */
const noun = z
  .string()
  .min(2)
  .max(24)
  .regex(/^[a-z][a-z -]*[a-z]$/, "lowercase words only")
  .refine((v) => !hasModelId(v), NO_MODEL_NAMES);

const BrandSchema = z
  .object({
    name: plainText(80),
    shortName: plainText(32),
    tagline: plainText(120).optional(),
    /** Legal operator shown in privacy, terms and the footer. */
    operatorName: plainText(120),
    supportEmail: z.string().max(254).email(),
    /** Canonical https origin. APP_URL in the environment still wins at runtime. */
    siteUrl: origin,
    /** The OSS repository link (GitHub button, "powered by"). */
    upstreamUrl: httpsUrl,
    /** Footer reads "<name> · powered by Real-Time Call Trainer". */
    poweredBy: z.boolean(),
    /** GitHub, contribute and model-defaults sections, and the OSS header pill. */
    showOssSections: z.boolean(),
    logo: z.object({ mark: assetPath, wordmark: assetPath.optional(), alt: plainText(120) }).strict().optional(),
    icon: assetPath.optional(),
    favicon: assetPath.optional(),
    disclaimer: plainText(240).optional(),
  })
  .strict();

const ThemeSchema = z
  .object({
    primary: z.string().regex(HEX, "use #rrggbb in lowercase").optional(),
    primaryDark: z.string().regex(HEX, "use #rrggbb in lowercase").optional(),
  })
  .strict();

const CopySchema = z
  .object({
    landing: z
      .object({ eyebrow: plainText(80).optional(), headline: plainText(100).optional(), subhead: plainText(240).optional(), featureBlurb: plainText(240).optional() })
      .strict(),
    library: z.object({ intro: plainText(160).optional(), draftBanner: plainText(240).optional() }).strict(),
    wizard: z.object({ shareLine: plainText(240).optional() }).strict(),
    team: z.object({ noOrg: plainText(240).optional(), inviteHelp: plainText(240).optional() }).strict(),
    meta: z.object({ description: plainText(200).optional() }).strict(),
    terminology: z.object({ trainee: noun, customer: noun, team: noun, manager: noun }).strict(),
  })
  .strict();

const unique = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.array(item).max(max).refine((a) => new Set(a).size === a.length, "duplicate entries");

const PersonasSchema = z
  .object({
    /** Job family filter for the library: OSS JOB_FAMILIES ids or customFamilies ids. Must match at least one persona. */
    families: unique(slug(2, 32), 64).refine((a) => a.length > 0, "list at least one job family"),
    /** Extra data packs: tenants/<id>/personas/<pack>.json. */
    packs: unique(slug(2, 40), 16),
    includeOssPacks: z.boolean(),
    defaultScenarioId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
    /** Drafts stay labelled as drafts; nothing here can mark a persona reviewed. */
    showDrafts: z.boolean(),
    /** Tenant-declared job families, used only by this tenant's data packs. Ids must not reuse an OSS family id. */
    customFamilies: z
      .array(z.object({ id: slug(2, 32), label: plainText(40) }).strict())
      .max(12)
      .refine((a) => new Set(a.map((f) => f.id)).size === a.length, "duplicate custom family id"),
  })
  .strict();

const VoiceSchema = z
  .object({
    /** Fills a null Organization.voiceModelTier only. Premium still needs voiceModelComped = true in the database. */
    defaultTier: z.enum(VOICE_TIER_IDS),
    /** Used only when VOICE_ENGINE is unset. */
    enginePreference: z.enum(VOICE_ENGINE_IDS).optional(),
    /** A REALTIME_VOICES name (checked at build). The persona voice wins, then REALTIME_VOICE, then this. */
    defaultVoice: z.string().min(2).max(16).regex(/^[a-z]+$/).optional(),
  })
  .strict();

const FeaturesSchema = z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<FeatureKey, z.ZodBoolean>).strict();

const AccessSchema = z
  .object({
    mode: z.enum(ACCESS_MODES),
    publicPaths: unique(z.enum(PUBLIC_PATH_KEYS), PUBLIC_PATH_KEYS.length),
  })
  .strict();

/** A fully resolved tenant: tenants/calltrainer/tenant.json, or any overlay merged onto it. */
export const TenantConfigSchema = z
  .object({
    schemaVersion: z.literal(TENANT_SCHEMA_VERSION),
    id: slug(2, 40),
    brand: BrandSchema,
    theme: ThemeSchema,
    copy: CopySchema,
    personas: PersonasSchema,
    voice: VoiceSchema,
    features: FeaturesSchema,
    access: AccessSchema,
  })
  .strict();

export type TenantConfig = z.infer<typeof TenantConfigSchema>;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Throws when any object key, at any depth, is __proto__, constructor or prototype. */
export function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) throw new Error(`Tenant config: key "${key}" is not allowed (at ${path})`);
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Throws when the JSON text of `value` is over the 64 KiB cap. */
export function assertWithinCap(value: unknown, label = "Tenant config"): void {
  const size = byteLength(JSON.stringify(value) ?? "");
  if (size > TENANT_MAX_BYTES) throw new Error(`${label} is ${size} bytes; the limit is ${TENANT_MAX_BYTES}`);
}

/** Parses tenant.json text: size cap first, then JSON, then the forbidden-key check. Not schema-validated yet. */
export function parseTenantJson(text: string, label = "tenant.json"): unknown {
  if (byteLength(text) > TENANT_MAX_BYTES) throw new Error(`${label} is larger than ${TENANT_MAX_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${jsonErrorSummary(e)})`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  assertNoForbiddenKeys(parsed);
  return parsed;
}

function deepMerge(base: unknown, over: unknown): Json {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(base)) out[k] = v as Json;
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : (v as Json);
    return out;
  }
  // Arrays and scalars replace. Undefined (absent) keeps the base.
  return (over === undefined ? base : over) as Json;
}

/**
 * Readable zod issues, each with its dotted key, so a failing build names the field to fix. Never echoes a supplied
 * value: zod enum and literal messages quote what they received, so those are rewritten to list only what is allowed.
 */
export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${issueMessage(i)}`).join("; ");
}

function issueMessage(i: z.ZodIssue): string {
  switch (i.code) {
    case "invalid_enum_value":
      return `expected one of ${i.options.map(String).join(", ")}`;
    case "invalid_literal":
      return `expected ${JSON.stringify(i.expected)}`;
    case "invalid_type":
      return `expected ${i.expected}, got ${i.received}`;
    case "invalid_union_discriminator":
      return "not one of the allowed variants";
    default:
      return i.message;
  }
}

/** A JSON parse failure without the parser message, which can quote part of the input. Position only. */
export function jsonErrorSummary(e: unknown): string {
  const pos = e instanceof Error ? /position (\d+)/.exec(e.message)?.[1] : undefined;
  return pos ? `syntax error at character ${pos}` : "syntax error";
}

/**
 * Pure merge of a tenant overlay onto the defaults. Objects merge deeply; arrays and scalars replace. Forbidden keys
 * (__proto__, constructor, prototype) are rejected before merging, both inputs are capped at 64 KiB, and the result is
 * parsed again with the strict schema. Idempotent: merging the same overlay twice gives the same result.
 */
export function mergeTenantConfig(defaults: unknown, overlay: unknown): TenantConfig {
  for (const [label, v] of [["defaults", defaults], ["overlay", overlay]] as const) {
    if (!isPlainObject(v)) throw new Error(`Tenant config ${label} must be an object`);
    assertNoForbiddenKeys(v);
    assertWithinCap(v, `Tenant config ${label}`);
  }
  const merged = deepMerge(defaults, overlay);
  const parsed = TenantConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Tenant config is invalid: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

/** Brand fields a non-default tenant must set itself, so a client copy never ships the calltrainer.tech contact. */
export const REQUIRED_OVERRIDES = ["name", "shortName", "operatorName", "supportEmail", "siteUrl"] as const;

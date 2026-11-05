/**
 * Prebuild side of tenant config (scripts/prepare-tenant.ts). Node only: reads the tenant directory, merges and
 * validates it, checks assets and data packs, applies the deprecated legacy env shim and scans for secrets.
 * Never import this from app code; the app reads the result through src/lib/tenant.ts.
 *
 * It must not import modules that read src/generated (scenarios.ts, realtime.ts, personas, tenant.ts), because it
 * runs before that file exists. Checks that need them take the values as parameters (see libraryProblems).
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { themeContrastProblems } from "./brandCss";
import {
  DEFAULT_TENANT_ID,
  REQUIRED_OVERRIDES,
  TenantConfigSchema,
  assertNoForbiddenKeys,
  formatIssues,
  jsonErrorSummary,
  mergeTenantConfig,
  parseTenantJson,
  type TenantConfig,
} from "./tenant-schema";

export const DEFAULT_TENANT_DIR = "tenants/calltrainer";
export const MAX_ASSET_BYTES = 512 * 1024;
export const MAX_PACK_BYTES = 256 * 1024;
export const MAX_TENANT_JSON_BYTES = 64 * 1024;
export const MAX_PACK_PERSONAS = 64;
/** The only tenant directories the public repo may hold. Client tenants live in a private deploy repo. */
export const OSS_TENANT_IDS = ["calltrainer", "example"] as const;

type Env = Record<string, string | undefined>;

export interface ResolvedTenant {
  config: TenantConfig;
  /** Data pack personas, raw (status filled in as "draft" when missing). Validated by libraryProblems. */
  personas: unknown[];
  /** Asset files to write under public/tenant/: the bytes that were checked, so nothing is read twice. */
  assets: { name: string; data: Buffer }[];
  /** Deprecation notices for legacy env variables. */
  warnings: string[];
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Legacy env shim (deprecated)                                                                                   */
/* ------------------------------------------------------------------------------------------------------------- */

export const LEGACY_ENV = [
  "NEXT_PUBLIC_BRAND_NAME",
  "NEXT_PUBLIC_BRAND_SHORT_NAME",
  "NEXT_PUBLIC_BRAND_TAGLINE",
  "NEXT_PUBLIC_BRAND_LOGO",
  "NEXT_PUBLIC_BRAND_PRIMARY",
  "NEXT_PUBLIC_BRAND_PRIMARY_DARK",
  "NEXT_PUBLIC_PERSONA_FAMILIES",
] as const;

// Error messages name the variable, never its value: a key pasted into the wrong variable must not reach build logs.
function legacyHex(name: string, raw: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (!m) throw new Error(`${name} is not a #rrggbb color (value not shown)`);
  return `#${m[1].toLowerCase()}`;
}

/**
 * Maps the AirPets-era NEXT_PUBLIC_BRAND_* and NEXT_PUBLIC_PERSONA_FAMILIES variables onto a config overlay, the way the
 * AirPets brand layer read them. A custom NEXT_PUBLIC_BRAND_NAME also hides the OSS sections and turns on "powered by",
 * and the short name falls back to it. Blank variables are ignored. Deprecated: use a tenant directory instead.
 */
export function legacyEnvOverlay(env: Env): { overlay: Record<string, unknown>; used: string[] } {
  const v = (k: (typeof LEGACY_ENV)[number]) => env[k]?.trim() ?? "";
  const brand: Record<string, unknown> = {};
  const theme: Record<string, unknown> = {};
  const personas: Record<string, unknown> = {};
  const name = v("NEXT_PUBLIC_BRAND_NAME");
  if (name) Object.assign(brand, { name, shortName: name, showOssSections: false, poweredBy: true });
  if (v("NEXT_PUBLIC_BRAND_SHORT_NAME")) brand.shortName = v("NEXT_PUBLIC_BRAND_SHORT_NAME");
  if (v("NEXT_PUBLIC_BRAND_TAGLINE")) brand.tagline = v("NEXT_PUBLIC_BRAND_TAGLINE");
  const logo = v("NEXT_PUBLIC_BRAND_LOGO");
  if (logo) {
    if (!logo.startsWith("/tenant/")) {
      throw new Error("NEXT_PUBLIC_BRAND_LOGO must be a /tenant/<file> path (value not shown). Copy the file into the tenant's assets/ folder and set brand.logo.mark instead.");
    }
    brand.logo = { mark: logo, alt: `${name || "Brand"} logo` };
  }
  if (v("NEXT_PUBLIC_BRAND_PRIMARY")) theme.primary = legacyHex("NEXT_PUBLIC_BRAND_PRIMARY", v("NEXT_PUBLIC_BRAND_PRIMARY"));
  if (v("NEXT_PUBLIC_BRAND_PRIMARY_DARK")) theme.primaryDark = legacyHex("NEXT_PUBLIC_BRAND_PRIMARY_DARK", v("NEXT_PUBLIC_BRAND_PRIMARY_DARK"));
  const families = v("NEXT_PUBLIC_PERSONA_FAMILIES").split(",").map((f) => f.trim()).filter(Boolean);
  if (families.length) personas.families = families;
  const overlay: Record<string, unknown> = {};
  if (Object.keys(brand).length) overlay.brand = brand;
  if (Object.keys(theme).length) overlay.theme = theme;
  if (Object.keys(personas).length) overlay.personas = personas;
  // Only variables that changed something count as used (a list of only commas does not).
  const used = LEGACY_ENV.filter((k) => (k === "NEXT_PUBLIC_PERSONA_FAMILIES" ? families.length > 0 : v(k) !== ""));
  return { overlay, used };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Secret scan                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------- */

/** Key-shaped strings that must never appear in tenant files or the generated config. */
export const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "OpenAI-style key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/ },
  { label: "Stripe key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/ },
  { label: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{8,}/ },
  { label: "ElevenLabs key", re: /\bsk_[a-f0-9]{32,}\b/ },
  { label: "ephemeral token", re: /\bek_[A-Za-z0-9_-]{8,}/ },
  { label: "PEM block", re: /-----BEGIN [A-Z0-9 ]+-----/ },
  { label: "database URL", re: /\bpostgres(?:ql)?:\/\/\S*/i },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Google OAuth secret", re: /\bGOCSPX-[A-Za-z0-9_-]{10,}/ },
];

/** JSON field names that look like they hold a secret. */
export const SECRET_FIELD = /key|secret|token|password|passwd|code/i;
/** Field names that match SECRET_FIELD but are plain public data. */
export const SECRET_FIELD_ALLOWLIST = new Set<string>([]);

/** Replaces every secret-shaped substring with [redacted]. Applied to every message the prebuild prints. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, { re }) => t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]"), text);
}

/** Secret-shaped strings in text, as "<label> at line N". */
export function secretFindings(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { label, re } of SECRET_PATTERNS) if (re.test(line)) out.push(`${label} at line ${i + 1}`);
  });
  return out;
}

/** Field names in a JSON value that look secret-bearing, outside the allowlist. */
export function secretFieldFindings(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretFieldFindings(v, `${path}[${i}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(SECRET_FIELD.test(k) && !SECRET_FIELD_ALLOWLIST.has(k) ? [`secret-like field "${k}" at ${path}`] : []),
    ...secretFieldFindings(v, `${path}.${k}`),
  ]);
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Directory loading                                                                                              */
/* ------------------------------------------------------------------------------------------------------------- */

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ico: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
};

/** Every /tenant/ path the config references, with the key that names it. */
export function assetRefs(config: TenantConfig): { key: string; path: string }[] {
  const b = config.brand;
  const refs: { key: string; path: string | undefined }[] = [
    { key: "brand.logo.mark", path: b.logo?.mark },
    { key: "brand.logo.wordmark", path: b.logo?.wordmark },
    { key: "brand.icon", path: b.icon },
    { key: "brand.favicon", path: b.favicon },
  ];
  return refs.filter((r): r is { key: string; path: string } => !!r.path);
}

/**
 * Reads `base/<parts...>` only if it stays inside the tenant directory: no component below `base` (folder or file) may
 * be a symbolic link, the target must be a regular file, and its real path must sit under the real tenant directory.
 * A linked assets/ or personas/ folder fails closed instead of reading files from elsewhere.
 */
export function readContainedFile(base: string, parts: string[], max: number, label: string): Buffer {
  const shown = parts.join("/");
  let path = base;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    if (!existsSync(path) && !isLink(path)) throw new Error(`${label}: ${shown} not found in the tenant directory`);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`${label}: ${parts.slice(0, i + 1).join("/")} must not be a link`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`${label}: ${parts.slice(0, i + 1).join("/")} must be a folder`);
  }
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`${label}: ${shown} must be a regular file`);
  const realBase = realpathSync(base);
  const rel = relative(realBase, realpathSync(path));
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`${label}: ${shown} is outside the tenant directory`);
  if (st.size > max) throw new Error(`${label}: ${st.size} bytes is over the ${max} byte limit`);
  return readFileSync(path);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Problems with a resolved config that need no persona library: contrast, ids, required overrides. */
export function configProblems(config: TenantConfig, opts: { dirName: string; defaults: TenantConfig }): string[] {
  const problems = [...themeContrastProblems(config.theme)];
  if (config.id !== opts.dirName) problems.push(`id: "${config.id}" must match the tenant directory name "${opts.dirName}"`);
  if (config.id !== DEFAULT_TENANT_ID) {
    for (const k of REQUIRED_OVERRIDES) {
      if (config.brand[k] === opts.defaults.brand[k]) problems.push(`brand.${k}: a tenant must set its own value instead of the calltrainer.tech default`);
    }
  }
  return problems;
}

/** Reads, merges and validates the tenant at `dir` (TENANT_CONFIG_DIR) on top of the default tenant under `root`. */
export function resolveTenantDir(opts: { root: string; dir?: string; env?: Env }): ResolvedTenant {
  const env = opts.env ?? {};
  const dirArg = opts.dir?.trim() || DEFAULT_TENANT_DIR;
  const dir = isAbsolute(dirArg) ? dirArg : resolve(opts.root, dirArg);
  const defaultsPath = resolve(opts.root, DEFAULT_TENANT_DIR, "tenant.json");
  // The directory value is not echoed: messages name keys and files inside the tenant, never supplied values.
  if (!existsSync(join(dir, "tenant.json"))) throw new Error("TENANT_CONFIG_DIR has no tenant.json (point it at a tenant directory such as tenants/example)");

  const defaultsRaw = parseTenantJson(readFileSync(defaultsPath, "utf8"), `${DEFAULT_TENANT_DIR}/tenant.json`);
  const defaultsParsed = TenantConfigSchema.safeParse(defaultsRaw);
  if (!defaultsParsed.success) throw new Error(`${DEFAULT_TENANT_DIR}/tenant.json is invalid: ${formatIssues(defaultsParsed.error)}`);
  const defaults = defaultsParsed.data;

  const overlayText = readContainedFile(dir, ["tenant.json"], MAX_TENANT_JSON_BYTES, "tenant.json").toString("utf8");
  // Scan the raw inputs before any parsing or validation, so no later error can quote a secret. Labels only.
  const early = [
    ...secretFindings(overlayText).map((f) => `tenant.json: ${f}`),
    ...LEGACY_ENV.filter((k) => secretFindings(env[k] ?? "").length).map((k) => `${k}: looks like a secret`),
  ];
  if (early.length) throw new Error(`Tenant is invalid:\n  - secret scan: ${early.join("\n  - secret scan: ")}`);

  const overlay = parseTenantJson(overlayText, "tenant.json");
  let config = mergeTenantConfig(defaults, overlay);

  const legacy = legacyEnvOverlay(env);
  const warnings = legacy.used.map((k) => `${k} is deprecated; set the matching key in the tenant's tenant.json instead`);
  if (legacy.used.length) config = mergeTenantConfig(config, legacy.overlay);

  const problems = configProblems(config, { dirName: basename(dir), defaults });

  const assets: ResolvedTenant["assets"] = [];
  for (const { key, path } of assetRefs(config)) {
    const name = path.slice("/tenant/".length);
    try {
      const buf = readContainedFile(dir, ["assets", name], MAX_ASSET_BYTES, key);
      const ext = name.split(".").pop() ?? "";
      if (!MAGIC[ext]?.(buf)) problems.push(`${key}: ${name} is not a real .${ext} file`);
      if (!assets.some((a) => a.name === name)) assets.push({ name, data: buf });
    } catch (e) {
      problems.push(e instanceof Error ? e.message : `${key}: unreadable`);
    }
  }

  const personas: unknown[] = [];
  for (const pack of config.personas.packs) {
    const label = `personas.packs "${pack}"`;
    try {
      const text = readContainedFile(dir, ["personas", `${pack}.json`], MAX_PACK_BYTES, label).toString("utf8");
      const leaks = secretFindings(text);
      if (leaks.length) throw new Error(`${label}: secret scan: ${leaks.join(", ")}`);
      let list: unknown;
      try {
        list = JSON.parse(text);
      } catch (e) {
        throw new Error(`${label}: not valid JSON (${jsonErrorSummary(e)})`);
      }
      assertNoForbiddenKeys(list);
      if (!Array.isArray(list) || !list.length) throw new Error(`${label}: must be a non-empty JSON array of personas`);
      if (list.length > MAX_PACK_PERSONAS) throw new Error(`${label}: ${list.length} personas is over the ${MAX_PACK_PERSONAS} limit`);
      for (const p of list) {
        if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error(`${label}: every entry must be an object`);
        // Never auto-reviewed: a data pack persona without a status is a draft, not the schema's "reviewed" default.
        personas.push({ ...p, status: (p as { status?: unknown }).status ?? "draft" });
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : `${label}: unreadable`);
    }
  }

  const findings = [...secretFindings(JSON.stringify(config, null, 2)), ...secretFieldFindings(config), ...secretFieldFindings(personas)];
  problems.push(...findings.map((f) => `secret scan: ${f}`));

  if (problems.length) throw new Error(redactSecrets(`Tenant "${config.id}" is invalid:\n  - ${problems.join("\n  - ")}`));
  return { config, personas, assets, warnings };
}

/* ------------------------------------------------------------------------------------------------------------- */
/* Library-level checks (phase 2, after src/generated exists)                                                    */
/* ------------------------------------------------------------------------------------------------------------- */

export interface LibraryContext {
  ossFamilyIds: readonly string[];
  voices: readonly string[];
  /** Ids in the filtered library this build offers. */
  libraryIds: readonly string[];
}

/** Checks that need the OSS family list, the voice list and the built library. */
export function libraryProblems(config: TenantConfig, ctx: LibraryContext): string[] {
  const problems: string[] = [];
  const oss = new Set(ctx.ossFamilyIds);
  for (const f of config.personas.customFamilies) {
    if (oss.has(f.id)) problems.push(`personas.customFamilies: "${f.id}" is already an OSS job family`);
  }
  const known = new Set([...oss, ...config.personas.customFamilies.map((f) => f.id)]);
  for (const f of config.personas.families) if (!known.has(f)) problems.push(`personas.families: "${f}" is not a job family id`);
  if (config.voice.defaultVoice && !ctx.voices.includes(config.voice.defaultVoice)) {
    problems.push(`voice.defaultVoice: "${config.voice.defaultVoice}" is not one of ${ctx.voices.join(", ")}`);
  }
  if (!ctx.libraryIds.length) problems.push("personas.families: the filter matches no persona");
  if (config.personas.defaultScenarioId && !ctx.libraryIds.includes(config.personas.defaultScenarioId)) {
    problems.push(`personas.defaultScenarioId: "${config.personas.defaultScenarioId}" is not in this tenant's library`);
  }
  return problems;
}

/** Tenant directories in the repo's tenants/ folder. CI fails if any is not calltrainer or example. */
export function listTenantDirs(root: string): string[] {
  const dir = join(root, "tenants");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

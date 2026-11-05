/**
 * The tenant this build ships as. Client-safe: everything here is public data that also reaches the browser.
 *
 * src/generated/tenant.json is written by `npm run tenant` (scripts/prepare-tenant.ts), which runs before dev, build,
 * test, typecheck and validate:personas. It reads TENANT_CONFIG_DIR (default tenants/calltrainer), validates and
 * merges the config, and fails the build when it is invalid. The file is gitignored; never commit it.
 *
 * With the default tenant every accessor below returns today's calltrainer.tech values. Runtime env still wins where
 * it always did: APP_URL over brand.siteUrl, capabilities and secrets over any config switch.
 */
import generated from "@/generated/tenant.json";
import { brandCss } from "./brandCss";
import { DEFAULT_TENANT_ID, TenantConfigSchema, formatIssues, type FeatureKey, type TenantConfig } from "./tenant-schema";

function load(): TenantConfig {
  const parsed = TenantConfigSchema.safeParse(generated);
  if (!parsed.success) throw new Error(`src/generated/tenant.json is invalid (run npm run tenant): ${formatIssues(parsed.error)}`);
  return parsed.data;
}

export const tenant: TenantConfig = load();
export const brand = tenant.brand;
export const tenantCopy = tenant.copy;

/** True for the stock calltrainer.tech build. */
export const isDefaultTenant = tenant.id === DEFAULT_TENANT_ID;

/** Host of the configured site URL, such as "calltrainer.tech", for legal copy. */
export const siteHost = new URL(brand.siteUrl).host;

/** Primary color overrides for the layout's <style> tag. Empty for the default tenant. */
export const BRAND_CSS = brandCss(tenant.theme.primary, tenant.theme.primaryDark);

/** Config half of a feature switch: false only when the tenant turned it off. */
export const featureAllowed = (key: FeatureKey, config: TenantConfig = tenant): boolean => config.features[key] !== false;

/** The /for/* vertical pages are calltrainer.tech marketing with plan prices: they need both publicLanding and pricing. */
export const verticalsAllowed = (config: TenantConfig = tenant): boolean => featureAllowed("publicLanding", config) && featureAllowed("pricing", config);

/**
 * Fail closed: a feature is on only when the tenant allows it AND the runtime capability is there. Config can never
 * turn on billing, Google sign-in or voice; those still need their env keys.
 */
export const featureOn = (key: FeatureKey, capability: boolean, config: TenantConfig = tenant): boolean =>
  featureAllowed(key, config) && capability === true;

/**
 * voice.defaultTier fills a null or empty stored Organization.voiceModelTier and nothing else. The result still goes
 * through effectiveVoiceTier, so Premium needs voiceModelComped = true whatever the config says.
 */
export function storedOrDefaultTier(stored: string | null | undefined, config: TenantConfig = tenant): string {
  return typeof stored === "string" && stored.trim() ? stored : config.voice.defaultTier;
}

/**
 * What PATCH /api/team/voice stores. Standard is stored as null, as before, unless the tenant default is Premium: then an
 * explicit Standard choice is stored as "standard" so the default cannot fill it back in.
 */
export function tierToStore(tier: "standard" | "premium", config: TenantConfig = tenant): "premium" | "standard" | null {
  if (tier === "premium") return "premium";
  return config.voice.defaultTier === "premium" ? "standard" : null;
}

/** The persona trainer opens with when nothing else was asked for or practised last. */
export const DEFAULT_SCENARIO_ID: string | undefined = tenant.personas.defaultScenarioId;

/** copy.terminology nouns. Default tenant: rep, buyer, team, manager. Reserved: no screen reads them yet. */
export const terms = tenant.copy.terminology;

/** "<page> · <brand name>" document titles. */
export const pageTitle = (page: string) => `${page} · ${brand.name}`;

const DEFAULT_DESCRIPTION =
  "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.";
const TENANT_DESCRIPTION = "Practise calls against AI personas. A live coach scores every turn, and the debrief backs every score with your own words.";

/** Home page and default metadata title. */
export const HOME_TITLE = isDefaultTenant || brand.showOssSections
  ? `${brand.name} · Hosted AI sales call practice, no setup`
  : `${brand.name} · Practise live calls with an AI coach`;

/** Default meta description: copy.meta.description, else today's text for OSS builds, else a neutral one. */
export const META_DESCRIPTION = tenant.copy.meta.description ?? (isDefaultTenant || brand.showOssSections ? DEFAULT_DESCRIPTION : TENANT_DESCRIPTION);

type IconLink = { url: string; type?: string; sizes?: string };
/** The root layout's metadata.icons, or undefined to leave the App Router file convention in charge. */
export type TenantIcons = { icon: IconLink[]; shortcut?: IconLink[] } | undefined;

/**
 * Browser tab icons. With neither brand.icon nor brand.favicon (the default tenant) this is undefined, so Next serves
 * src/app/icon.svg as before: a content-hashed /icon.svg URL with its own caching. Next uses that file only when
 * metadata.icons is unset, so a tenant icon replaces it, and a favicon alone keeps the stock /icon.svg next to it.
 */
export function tenantIcons(b: Pick<TenantConfig["brand"], "icon" | "favicon"> = brand): TenantIcons {
  if (!b.icon && !b.favicon) return undefined;
  return {
    icon: b.icon ? [{ url: b.icon }] : [{ url: "/icon.svg", type: "image/svg+xml", sizes: "any" }],
    ...(b.favicon ? { shortcut: [{ url: b.favicon }] } : {}),
  };
}

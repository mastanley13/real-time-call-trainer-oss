# Tenants: a branded deployment from config, not a fork

A tenant is one company's copy of the app: its own name, colors, logo, copy, personas, feature switches and access
mode, described by a **tenant directory**. Every tenant is its own deployment (its own Vercel project, database,
`JWT_SECRET`, `CRON_SECRET` and provider keys). Nothing about the tenant is read from the request; it is picked at
build time.

With `TENANT_CONFIG_DIR` unset the build is the stock calltrainer.tech app (`tenants/calltrainer`).

## The rule

**Config can hide, rename or select. It never grants.**

- Secrets, keys, the access code, database URLs and model ids stay in the environment. The schema has no field that
  can hold one, unknown keys fail, and a scan rejects key-shaped strings and secret-named fields.
- A feature is on only when the tenant allows it **and** the runtime capability is there
  (`featureOn(key, capability)` in `src/lib/tenant.ts`). Config alone cannot turn on billing, Google sign-in or voice.
- `voice.defaultTier: "premium"` only fills a null `Organization.voiceModelTier`. A call still runs on Premium only
  when `voiceModelComped` is true in the database.
- Data pack personas without a `status` are drafts. Nothing in config marks a persona reviewed.

## Layout

```
tenants/<id>/
  tenant.json            data only, at most 64 KiB, overlay on tenants/calltrainer/tenant.json
  assets/<file>          PNG, ICO or WebP, at most 512 KiB each (SVG is excluded in v1)
  personas/<pack>.json   optional data packs: a JSON array of personas (ScenarioSchema, strict)
```

The public repository holds only `tenants/calltrainer` (the default) and `tenants/example` (fictional, used by tests
and these docs). A test fails if anything else appears. **Client tenants live in a private deploy repo**, built
against a pinned OSS commit; never open a pull request with client config or personas to the public repo.

## How a build picks it up

`npm run tenant` (`scripts/prepare-tenant.ts`) runs before `dev`, `build`, `test`, `typecheck` and
`validate:personas`. It:

1. reads `TENANT_CONFIG_DIR` (default `tenants/calltrainer`), relative to the repo root or absolute;
2. merges `tenant.json` onto the defaults with `mergeTenantConfig` (objects merge deeply, arrays and scalars
   replace, `__proto__`/`constructor`/`prototype` are rejected) and parses the result with the strict schema;
3. applies the deprecated legacy env shim (below);
4. checks contrast, asset files, data packs, the job family filter, the default persona and voice, and runs the
   secret scan;
5. copies the referenced assets to `public/tenant/` and writes `src/generated/tenant.json` and
   `src/generated/tenant-personas.json`.

Every problem is listed with the key to fix, and the build stops. There is no fallback to the default brand. The
generated files and `public/tenant/` are gitignored; never commit them.

A brand change needs a rebuild: values are inlined into the server and client bundles.

## Precedence

1. `tenants/calltrainer/tenant.json` (defaults)
2. the tenant's `tenant.json`
3. legacy env: `NEXT_PUBLIC_BRAND_*`, `NEXT_PUBLIC_PERSONA_FAMILIES` (deprecated)
4. runtime env, which stays authoritative for capabilities and secrets: `APP_URL` over `brand.siteUrl`,
   `VOICE_ENGINE` over `voice.enginePreference`, `REALTIME_VOICE` over `voice.defaultVoice`, every provider key.

## Schema v1

Every object is strict. `?` marks optional fields.

| Key | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `id` | slug, 2 to 40 chars, must equal the directory name |
| `brand.name`, `brand.shortName`, `brand.tagline?` | plain text, at most 80, 32 and 120 chars. Header label, titles, MFA issuer, share cards |
| `brand.operatorName` | the legal operator in privacy, terms, pricing and the footer |
| `brand.supportEmail` | Contact links and legal pages |
| `brand.siteUrl` | https origin with no path. `APP_URL` still wins |
| `brand.upstreamUrl` | https link to the OSS repo (GitHub button, "powered by") |
| `brand.poweredBy` | footer reads "<name> · powered by Real-Time Call Trainer" |
| `brand.showOssSections` | GitHub, contribute and "What runs each job" sections, the OSS header pill |
| `brand.logo?` | `{ mark, wordmark?, alt }`, each a `/tenant/<file>` path |
| `brand.icon?`, `brand.favicon?` | `/tenant/<file>` paths. Default: `/icon.svg` |
| `brand.disclaimer?` | plain text at most 240 chars, shown in the footers and on sign-in and sign-up |
| `theme.primary?`, `theme.primaryDark?` | lowercase `#rrggbb`. Generates the primary tokens; without a dark color the dark theme uses a lighter shade |
| `copy.landing.{eyebrow,headline,subhead,featureBlurb}?` | landing hero and first feature card |
| `copy.library.{intro,draftBanner}?` | library header line and draft banner |
| `copy.wizard.shareLine?` | the wizard's "share it" paragraph |
| `copy.team.{noOrg,inviteHelp}?` | the team page "not on a team" message (`inviteHelp` is reserved for a reviewed invite flow) |
| `copy.meta.description?` | default meta description |
| `copy.terminology.{trainee,customer,team,manager}` | nouns for UI slots (reserved: no screen reads them yet) |
| `personas.families` | job family ids for the library, at least one, must match at least one persona |
| `personas.packs` | data pack ids in `personas/` |
| `personas.includeOssPacks` | include the TypeScript OSS packs |
| `personas.defaultScenarioId?` | the persona the trainer opens with; must be in the filtered library |
| `personas.showDrafts` | show draft personas (labelled) or only reviewed ones |
| `personas.customFamilies` | `[{ id, label }]` tenant job families for data packs, at most 12; ids may not reuse an OSS id |
| `voice.defaultTier` | `standard` or `premium`, fills a null org tier only |
| `voice.enginePreference?` | `openai` or `elevenlabs`, used when `VOICE_ENGINE` is unset |
| `voice.defaultVoice?` | a `REALTIME_VOICES` name, after the persona voice and `REALTIME_VOICE` |
| `features.*` | `pricing billing googleSignIn wizard urlImport teamView invites voiceQualityPanel commandPalette publicLanding`, each can only turn a feature off |
| `access.mode` | `accounts` (access code optional, as today) or `accounts_and_code` (code required) |
| `access.publicPaths` | the subset of the OSS public-path allowlist that stays public behind the access code |

Copy fields are rendered as text. The build rejects `<` and `>`, URLs and domain names, em dashes and line breaks.

### Validation

- Colors: button text on the primary must reach 4.5:1, and the primary against the page and surface must reach 3:1, in
  daylight and in the dark theme and call deck. The message names the key (`theme.primary` or `theme.primaryDark`).
- Assets: `/tenant/<file>` only, no `..` or `//`, a regular file (no links) whose bytes match its extension.
- Non-default tenants must set `brand.name`, `shortName`, `operatorName`, `supportEmail` and `siteUrl` themselves, so a
  client copy never ships the calltrainer.tech contact.

### What each feature switch does when off

| Feature | Off means |
|---|---|
| `pricing` | `/pricing` is 404, Pricing leaves the header, menu, footer and sitemap, landing CTAs point at the library |
| `billing` | `stripeStatus` reads as disabled, so checkout, plans and Stripe metering act as if Stripe were unset |
| `googleSignIn` | `googleConfig()` is null: no button, `/api/auth/google/*` return 404 |
| `wizard` | `/library/new` is 404, `/api/persona/generate` and `/api/persona/fetch-url` return 404 `feature_disabled`, the create buttons go |
| `urlImport` | the wizard hides URL import (pasting page text still works) and `/api/persona/fetch-url` returns 404 |
| `teamView` | `/team` is 404 and leaves the nav and command palette |
| `invites` | reserved. OSS has no invite link flow yet; it will only ship after a reviewed least-privilege design |
| `voiceQualityPanel` | the Team page voice panel is hidden. It is also hidden whenever realtime voice is not configured |
| `commandPalette` | no Ctrl K palette or header button |
| `publicLanding` | `/` leaves the public paths (gated when the access code is on) and the sitemap. The `/for/*` vertical pages need both `publicLanding` and `pricing` |

### Access modes

- `accounts`: today's behaviour. The access gate is on only when `TRAINER_ACCESS_CODE` is set.
- `accounts_and_code`: the gate is required. Without `TRAINER_ACCESS_CODE`, every page and API answers 503
  `access_code_not_configured` (except `/api/health`, cron and the Stripe webhook), and `/api/health` reports
  `checks.accessCode: "missing"` with status 503. The code value only ever comes from the environment.

`access.publicPaths` entries: `/`, `/privacy`, `/terms`, `/pricing`, `/register`, `/login`, `/auth/complete`,
`/robots.txt`, `/sitemap.xml`, `/for/*`, `/opengraph-image` (root and vertical share images), `/api/auth/*`. The gate's
own `/access` and `/api/access`, `/api/health`, `/api/cron/*` and `/api/stripe/webhook` are always reachable.

## Personas and tenant job families

- OSS TypeScript packs stay where they are (`src/lib/personas/<family>.ts`).
- Data packs are JSON arrays of personas validated by `DataPersonaSchema` (`ScenarioSchema`, strict at every level:
  unknown fields on the persona, `aiPersona`, rubric criteria or objections fail). The prebuild then runs the same
  rules as `npm run validate:personas` (`src/lib/personaChecks.ts`) over every persona the tenant carries, not only the
  filtered library, and fails on any error.
- Files are read only from inside the tenant directory: a linked `tenant.json`, `assets/`, `personas/` or file fails.
- Build messages never quote env values or JSON excerpts, and key-shaped strings are redacted.
- A data pack may use an OSS family or one declared in `personas.customFamilies`. Ids must start with `<family>-` like
  OSS packs. Custom family labels show in the library, briefing and palette. The persona wizard and the scenario
  editor still offer only OSS families.
- Data packs come last in library order. Duplicate ids across OSS and data packs fail the build.

## Legacy env shim (deprecated)

For the AirPets-era variables, set at build time:

| Variable | Maps to |
|---|---|
| `NEXT_PUBLIC_BRAND_NAME` | `brand.name` and `brand.shortName`, and turns `showOssSections` off and `poweredBy` on |
| `NEXT_PUBLIC_BRAND_SHORT_NAME` | `brand.shortName` |
| `NEXT_PUBLIC_BRAND_TAGLINE` | `brand.tagline` |
| `NEXT_PUBLIC_BRAND_LOGO` | `brand.logo.mark`; must already be a `/tenant/<file>` path in the tenant's `assets/` |
| `NEXT_PUBLIC_BRAND_PRIMARY`, `NEXT_PUBLIC_BRAND_PRIMARY_DARK` | `theme.primary`, `theme.primaryDark` (`#` optional, any case) |
| `NEXT_PUBLIC_PERSONA_FAMILIES` | `personas.families` (comma-separated) |

Blank variables are ignored; unusable values fail the build with the variable name. Each one used prints a
deprecation warning. Move them into `tenant.json`.

## Try the example tenant

```bash
npm run test:example-tenant
TENANT_CONFIG_DIR=tenants/example DEMO_MODE=true npm run dev
```

`npm run test:example-tenant` (`scripts/test-example-tenant.ts`) prepares the example tenant, runs no-model-labels and
the tenant runtime, access-mode, config and hardening tests and the persona validator under it, then always prepares
the default tenant again. `npm test` runs it after the main suite, so CI covers the example tenant through its existing
`npm test` step. After the dev server, run `npm run tenant` (no variable) to go back to the default.

## A new company

Recommended deploy repo layout, so the OSS `tenants/` folder (and its hygiene test) stays untouched:

```
private-deploy-repo/
  oss/                 the OSS repo at a pinned commit (submodule or vendored copy)
  tenants/<id>/        tenant.json, assets/, personas/
```

Build from `oss/` with `TENANT_CONFIG_DIR=../tenants/<id>` (relative paths resolve from the OSS root; absolute paths work too). The directory name must equal the tenant `id`.


See DEPLOY.md, "New company deployment": a private deploy repo with `tenants/<id>/`, a pinned OSS commit, and the
infra runbook for the per-tenant database, secrets and Vercel project. `TENANT_CONFIG_DIR` is the only brand hook;
everything else is the usual environment.

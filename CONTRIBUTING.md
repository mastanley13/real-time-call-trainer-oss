# Contributing

Thanks for helping improve Real-Time Call Trainer. The two easiest ways in are a new practice persona for a sales job you know, and a test for a pure module in `src/lib`. Both run with no API keys and no database.

Using a coding agent? Point it at [AGENTS.md](AGENTS.md): it has the project map, commands and rules in one place.

## Setup

```bash
git clone https://github.com/<you>/real-time-call-trainer-oss.git
cd real-time-call-trainer-oss
npm ci                      # Node 22+; also runs prisma generate
cp .env.example .env        # optional; everything in it is optional for local work
DEMO_MODE=true npm run dev  # http://localhost:3000, no login, no keys, no database
```

`DEMO_MODE=true` skips login and keeps sessions in your browser. Without an AI key the app uses a scripted caller, a rules-based coach, a template persona wizard and a heuristic grader, so every flow still works. Add `LLM_API_KEY` for the AI paths, and see [TESTING.md](TESTING.md) for what each setup unlocks.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run lint` | ESLint over `src` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (`tests/**/*.test.ts`) |
| `npm run validate:personas` | Checks every persona pack against the schema and pack rules |
| `npm run build` | `prisma generate` + `next build` (needs a postgres-shaped `DATABASE_URL` and a 32+ character `JWT_SECRET`; neither has to be live) |
| `npx tsx scripts/coach-smoke.ts` | Smoke test for the no-key coach, wizard and URL guard |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / seed a platform admin (full setup only) |

## Before you open a pull request

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs these on every pull request, so run them first:

```bash
npm run lint && npm run typecheck && npm test && npm run validate:personas
DATABASE_URL=postgresql://ci:ci@localhost:5432/ci JWT_SECRET=local-placeholder-0123456789abcdef0123 npm run build
```

Then walk the matching section of [TESTING.md](TESTING.md) with `DEMO_MODE=true`, and fill in the pull request template. Keep pull requests focused and describe the user-visible change.

If the maintainers have enabled it, a Codex review ([`.github/workflows/codex-review.yml`](.github/workflows/codex-review.yml)) comments on pull requests from branches in this repository. It runs only when the repository has an `OPENAI_API_KEY` Actions secret, and skips pull requests from forks. It is advice, not a gate; a maintainer makes the call.

## Dependencies and pinned actions

- **Dependabot** ([`.github/dependabot.yml`](.github/dependabot.yml)) checks weekly. npm minor and patch updates arrive grouped in one pull request (at most 5 npm pull requests open at once); each major update gets its own. GitHub Actions updates bump the pinned commit SHA and its version comment together.
- **Dependabot pull requests go through the same CI** as everyone else's. Read the lockfile diff before merging. GitHub does not give Dependabot pull requests the repository's Actions secrets, so the Codex review skips them.
- **Actions are pinned to full commit SHAs**, with the tag they matched in a trailing comment (`uses: actions/checkout@<40-character SHA> # v5.1.0`). A tag can be moved; a SHA cannot. Keep that form when you add or change a step. To upgrade by hand, run `git ls-remote --tags https://github.com/<owner>/<repo>` and use the peeled `^{}` commit for an annotated tag.
- **New npm dependencies**: open an issue first (see Code guidelines).

## Adding or improving a persona

Personas live in `src/lib/personas/<family>.ts`, one pack file per sales job family (`sdr.ts`, `insurance.ts`, `collections.ts` and so on). Each entry is a plain `Scenario` object validated by `ScenarioSchema` in `src/lib/scenarios.ts`.

1. Draft it with the wizard at `/library/new` (works without a key), or copy an entry from the same pack.
2. Press **Copy pack JSON** on the wizard's last step, paste the object at the end of the pack's array, change the id to `<family>-<short-slug>`, and keep `status: "draft"`.
3. Run `npm run validate:personas` until it shows 0 errors and 0 warnings.
4. Practise it once in text mode with no key and check that each objection comes up and the coach cues it.
5. Go through the review checklist (stereotypes, regulated-industry claims, fictional details) and open a pull request.

The full field reference, how objections and prep answers drive the live coach, scripted-reply coverage and the checklist are in [docs/PERSONA_PACKS.md](docs/PERSONA_PACKS.md). Can't write it yourself? Open a **Persona request** issue.

## Code guidelines

- **Design tokens only.** Colors come from the token names in `tailwind.config.ts` (`background`, `surface`, `sunken`, `ink`, `ink-soft`, `ink-muted`, `line`, `primary`, `signal`, `ok`, `caution`, `alert` and their variants), defined once in `src/app/globals.css` for daylight, dark and the `.deck` call scope. No hex or rgb literals, no `slate-*`/`red-*` palette classes. Reuse the component classes (`.card`, `.btn-primary`, `.chip`, `.lamp`, `.tape` ...). Icons are `lucide-react` at `strokeWidth={1.75}`. Check 375 px, dark mode and keyboard use.
- **UI copy**: plain, active voice, sentence case, no em dashes. Errors say what happened and how to fix it.
- **API routes**: `requireAuth` first, zod validation through `readJsonLimited`, per-IP limits (`ipLimitResponse`) on cost-bearing and write routes plus a per-account limit (`userLimitResponse` or `rateLimit` keyed on the user id), org scoping on stored data, errors shaped `{ error, message? }`. Never log or return secrets or raw provider error bodies. New per-IP scopes get `RATE_LIMIT_<SCOPE>_MAX` / `_WINDOW_SEC` overrides and a README row. Read the client IP with `clientIp(req)`, never from the headers directly.
- **Server-only code**: modules that read secrets or call providers start with `import "server-only"`. Shared types go in `*-types.ts` files.
- **Demo mode keeps working**: anything that needs a key or a database needs a fallback or a clear "not configured" state.
- **Tests**: add Vitest tests in `tests/` for pure logic you add or change. `@` points at `src`, and `server-only` is stubbed, so server modules import directly. No network, no real keys.
- **Database**: schema changes need a Prisma migration (`npx prisma migrate dev --name <change>`).
- **Dependencies**: open an issue before adding one.
- **Secrets and data**: never commit `.env` files, keys or real call transcripts. Use fictional names and `555-01xx` numbers in fixtures.

## Good first issues

Every pack file has three personas today. These gaps are good places to start; check open issues first so two people don't write the same one.

| Family | Idea |
|---|---|
| General sales (`general`) | No pack file yet. Start `src/lib/personas/general.ts` and add it to `PACKS` in `personas/index.ts` |
| SDR cold calls (`sdr`) | All three are cold calls. Add a follow-up after a no-show, or an inbound demo request |
| AE discovery (`ae`) | All three are discovery. Add a negotiation or a mutual-plan follow-up |
| Customer success (`cs`) | A renewal where the original champion has left (authority) |
| Insurance (`insurance`) | A service call about a denied or slow claim |
| Mortgage & lending (`mortgage`) | A refinance discovery call with a rate-shopping borrower |
| Real estate (`real-estate`) | A listing appointment discovery call with a seller who wants a high price |
| Solar & energy (`solar`) | A service call about lower-than-expected production |
| Auto sales (`auto`) | A service-drive call about a repair versus trade-in decision |
| Medical devices (`medical`) | A negotiation with a value-analysis committee |
| B2B procurement (`procurement`) | A follow-up after a lost bid |
| Recruiting (`recruiting`) | An offer negotiation with a candidate holding a competing offer |
| Retail & consumer (`retail`) | A follow-up on a high-value return or exchange |
| Collections (`collections`) | A call where a spouse manages the household finances (verify identity first) |
| Financial advising (`financial`) | A follow-up after a market drop with a nervous client |
| Logistics & freight (`logistics`) | A cold call to a shipper locked into a carrier contract |
| Telecom & utilities (`telecom`) | A renewal at the end of a business contract |
| Home services (`home-services`) | A negotiation over a maintenance plan upgrade |

Code-side starters: edge-case tests for the pure modules in `src/lib` (the suites in `tests/` show the pattern; the scripted caller, the rules-based coach and the SSRF guard all reward tricky inputs), and copy or accessibility fixes you find while walking [TESTING.md](TESTING.md).

## Reporting bugs and security issues

Use the **Bug report** issue form for bugs. Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License and conduct

By contributing you agree that your work is released under the MIT license. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub, not in a public issue or pull request.

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/mastanley13/real-time-call-trainer-oss/security/advisories/new>.
2. Describe the problem, the affected route or file, the setup you used (demo mode, keys, database, access code), steps to reproduce, and the impact you were able to show.
3. Leave real API keys, tokens and personal data out of the report. A redacted request and response is enough.

The maintainer aims to acknowledge reports within a week, agree a fix and disclosure date with you, and credit you in the advisory unless you would rather stay anonymous. Please give us a reasonable chance to ship a fix before you publish anything.

Only the latest commit on `main` is supported. There are no maintained release branches.

## Scope

In scope: code in this repository, including

- API routes in `src/app/api` (authentication, org scoping of saved sessions and supervisor notes, input validation, rate limits)
- voice credential minting (`/api/elevenlabs/token` for ElevenLabs, `/api/realtime/*` for OpenAI Realtime)
- the persona wizard's URL import and its SSRF guard (`src/lib/safeFetch.ts`)
- the optional access-code gate (`src/middleware.ts`, `src/lib/access.ts`)
- accounts, sessions and TOTP MFA (`src/lib/auth.ts`, `src/lib/mfa.ts`)
- anything that could leak a server-side secret to the browser, logs or a response
- the GitHub Actions workflows in `.github/workflows`

Out of scope:

- Deployments that set `DEMO_MODE=true` on a public URL. Demo mode turns authentication off by design and the docs say never to do that.
- Rate limits being per server instance. They are in-memory and best-effort on serverless; this is documented.
- Problems in third-party services (ElevenLabs, OpenAI or another LLM provider, your host), and findings that need a compromised device or browser.
- Volume-based denial of service, missing headers or best practices without a demonstrated impact, and social engineering.
- The behaviour of AI personas or the coach (for example getting a persona to break character). Report those as bugs.

## Protections in place

**Secrets stay on the server.** Provider keys (`ELEVENLABS_API_KEY`, `OPENAI_REALTIME_API_KEY`, `LLM_API_KEY`/`OPENAI_API_KEY`), `JWT_SECRET`, `CRON_SECRET` and the access code are read only in server code: route handlers, middleware, and modules marked `import "server-only"`. One module is shared on purpose: `src/lib/realtime.ts` holds pure helpers the call UI also imports, and its env readers evaluate to `undefined` in the browser because Next.js inlines only `NEXT_PUBLIC_*` variables into client bundles. `auth.ts` and `access.ts` read `JWT_SECRET` and the access code and are imported only by server code. `/api/config` returns capability booleans, the model id and whether the provider is OpenAI or custom, never a key or base URL. Provider error bodies are not passed through to the browser.

`OPENAI_API_KEY` is used for the coach, grading, wizard and text caller only while `LLM_BASE_URL` is unset or points at `https://api.openai.com`. With any other base URL the server sends `LLM_API_KEY` or no key at all, so an OpenAI key set for voice never goes to a third-party endpoint.

**Server-minted voice tokens.** The browser never receives a voice provider's API key. `/api/elevenlabs/token` and `/api/realtime/session` require a session, are rate-limited, and mint a short-lived credential for one call: an ElevenLabs conversation token, or an OpenAI Realtime client secret.

**SSRF guard on URL import.** The wizard's "Product page" import (`/api/persona/fetch-url`) fetches through `fetchPublicPage`, which:

- accepts only `http` and `https` on default ports, with no credentials in the URL
- rejects `localhost` and internal suffixes (`.local`, `.internal`, `.lan`, `.corp` and others)
- resolves the hostname and refuses it if any address is private, loopback, link-local (including cloud metadata such as `169.254.169.254`), CGNAT, multicast, reserved, documentation or unspecified, including IPv4-mapped, NAT64 and 6to4 IPv6 forms and IPv6 unique-local addresses
- connects only to an address that passed the check: every connection resolves the name through a lookup hook that rejects blocked addresses, so a DNS answer that changes after the check (DNS rebinding) cannot reach an internal host
- follows at most three redirects by hand and re-checks every hop
- times out after 8 seconds, stops reading after 1 MB, accepts only `text/html` or `text/plain`, and returns at most 8,000 characters of text

Defence in depth: if your host can reach sensitive internal services (cloud metadata with IMDSv1, admin panels), also run the app behind an egress firewall that blocks private ranges.

**Rate limits and size caps.** Cost-bearing routes have per-IP fixed-window limits, configurable with `RATE_LIMIT_*` variables. Defaults: text caller 30 per 5 minutes, grading and re-grades 10 per hour combined, ElevenLabs token 10 per hour, OpenAI Realtime session 10 per hour, live coach 120 per 10 minutes, persona wizard and URL import 20 per hour combined, access-code attempts 10 per 15 minutes. Sign-in, registration, MFA challenges and the model connection check have their own per-IP limits. Most routes also have a fixed per-account limit, so switching networks doesn't get around the IP limit: for example the wizard 20 per hour, re-grades 5 per 10 minutes, the model connection check 20 per hour, OpenAI Realtime sessions 6 per minute. [TESTING.md](TESTING.md#rate-limits) lists every limit. The client IP is read from `X-Forwarded-For`, counting `TRUSTED_PROXY_HOPS` entries from the right (default 1). When the app runs behind at least one proxy that sets or appends `X-Forwarded-For`, and that number matches those proxies, a client can't choose its own address by sending the header. Without such a proxy, any client can, whatever the setting ([DEPLOY.md](DEPLOY.md#client-ip-behind-proxies)). Request bodies are capped at 200 KB. The text caller accepts up to 200 turns and 20,000 characters; the live coach reads only the most recent turns within that size; grading and re-grades read the first 1,000 turns and 120,000 characters of a call. Limits return 429. They are in-memory per instance; use a shared store for strict enforcement.

**Grades can't be forged.** `/api/evaluate-call` seals each grade with an HMAC keyed by `JWT_SECRET` over the user, the persona id, a digest of the transcript and the whole evaluation (`src/lib/gradeSeal.ts`). `POST /api/transcripts` stores a score only when the seal verifies, so team KPIs and assignment completion never read a score the client made up. Library personas are graded on the server's own copy of the rubric. Re-grades (`PATCH /api/transcripts/[id]`) grade the stored transcript, never one from the client; managers and owners of the session's organization and platform admins can re-grade any call on a library persona, while the trainee can only replace a grade that is not an AI grade (`canRegrade` in `src/lib/gradable.ts`). The server keeps no copy of a custom persona, so a call on one can be re-graded only from a browser that holds that persona; a request without it gets 400 `scenario_required`. Because a custom persona's rubric comes from the client, its grades are graded honestly but on a rubric the rep chose: the team view counts those calls as practice and leaves their scores, criteria and goal out of team KPIs, the heatmap and the coaching queue, and `POST /api/team/assignments` accepts library personas only (400 `invalid_persona`), so assignment completion always rests on the server's rubric.

**Optional access-code gate.** When `TRAINER_ACCESS_CODE` is set, middleware requires the code on every page and API route except `/api/health` and `/api/cron/*` (which uses a `CRON_SECRET` bearer token). The cookie holds an HMAC of the code keyed by `JWT_SECRET`, never the code itself; it is `httpOnly`, `sameSite=lax` and lasts 30 days. Codes are compared in constant time.

**Accounts.** Passwords are hashed with bcrypt (12 rounds), and only bcrypt hashes are accepted. Sessions are signed JWTs in `httpOnly`, `sameSite=lax` cookies (secure in production) that expire after 12 hours. TOTP MFA is available from `/settings/security`, with a separate five-minute challenge token between the password and code steps. Saved sessions and supervisor notes are readable only by their owner, by a manager or owner in the same organization, or by a platform admin. Only managers and owners of that organization, or a platform admin, can write a supervisor note. The note editor sends the version it loaded, and a save against an outdated copy is refused with 409 instead of overwriting someone else's note.

**Headers.** `next.config.ts` sets HSTS, `nosniff`, `X-Frame-Options: DENY`, a strict referrer policy, a permissions policy that allows only the microphone, and a content security policy.

**CI.** The CI workflow runs with a read-only token and no secrets. The Codex review workflow only runs for pull requests from branches in this repository, never for forks, and the job that holds the API key cannot write to the repository. Every action in `.github/workflows` is pinned to a full commit SHA, so a moved tag can't change what runs, and Dependabot (`.github/dependabot.yml`) proposes updates to those pins and to npm packages weekly.

## Personal data in practice calls

Practice transcripts, CRM notes and pasted calls can contain personal data.

- **Redact before you paste.** Text in the wizard's "CRM notes", "Ideal customer" and "Pasted call" tabs, and every practice transcript, is sent to the AI provider you configured. Remove customer names, phone numbers, emails, addresses, account or policy numbers, and health or financial details first. Use placeholders such as "the customer" or `555-0100`.
- **Know where it is stored.** Custom personas always stay in your browser's localStorage. In demo mode, sessions do too. With a database, sessions are stored in Postgres, scoped to your organization, and deleted by the retention job (`/api/cron/purge-expired`) after the organization's retention window.
- **Keep it out of the repository.** Persona packs, fixtures, issues and pull requests use fictional people, `555-01xx` numbers and invented addresses only. Pull requests that contain real transcripts or customer data will be closed.
- **Operators**: set a retention window, tell your reps what is recorded and where it goes, and review your provider's data-retention terms before using real customer material.

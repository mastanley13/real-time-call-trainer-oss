# Real-Time Call Trainer

Practice live sales and service calls against an AI caller, then get a debrief graded against a rubric you control, with every score backed by quotes from your own transcript.

By Mykel Stanley · MIT licensed

![Real-Time Call Trainer](public/screenshot.png)

## Features
- **Voice practice** with [ElevenLabs Agents](https://elevenlabs.io/docs/agents-platform) over WebRTC. The persona prompt, first message and voice are sent per call as overrides.
- **Editable scenarios**: talk track, industry, AI persona (name, role, behavior), trainee goal and a weighted rubric. Three built-ins (home-services inbound lead, quote follow-up, objection handling) are read-only but duplicable. Custom scenarios live in `localStorage`.
- **Rubric grading with evidence**: each criterion gets a score, a rationale and verbatim transcript quotes. Quotes that don't appear in the transcript are discarded.
- **Text-only simulated call** when voice is unavailable, with a scripted fallback caller if no LLM key is set.
- **Graceful degradation**: runs without ElevenLabs, an LLM key or a database (`DEMO_MODE=true`).
- **Teams and accounts** (optional): Postgres + Prisma, org join codes, TOTP MFA, supervisor notes, retention purge job.

## Architecture
```
Browser (Next.js App Router, Tailwind, @elevenlabs/react)
  ├─ /trainer          scenario picker, voice or text call, live transcript
  ├─ /trainer/scenarios scenario editor (localStorage)
  ├─ /trainer/debrief   rubric scores + quoted evidence
  └─ /dashboard        history and stats
Server routes (src/app/api)
  ├─ elevenlabs/token  mints a WebRTC conversation token (API key stays server-side)
  ├─ evaluate-call     grades a transcript against the scenario rubric (LLM or heuristic)
  ├─ simulate/turn     text-mode caller (LLM or scripted)
  ├─ transcripts       save / list / fetch sessions (Postgres)
  └─ auth/*, me, health, config, cron/purge-expired
```
Scenario definitions and the agent prompt builder are in `src/lib/scenarios.ts`; grading is in `src/lib/grader.ts`.

## Setup
```bash
git clone <your fork> && cd real-time-call-trainer
npm install
cp .env.example .env      # then edit
npm run dev               # http://localhost:3000
```
Quick look without any keys: `DEMO_MODE=true npm run dev`. See [TESTING.md](TESTING.md).

### Environment variables
| Variable | Required | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | For voice | Server-side key used to mint conversation tokens |
| `ELEVENLABS_AGENT_ID` | For voice | The agent to call |
| `LLM_API_KEY` | Optional | Post-call grading and text simulation (any OpenAI-compatible API). `OPENAI_API_KEY` is accepted as a fallback. Without it: heuristic grading, scripted caller |
| `LLM_BASE_URL` | Optional | Default `https://api.openai.com/v1` |
| `LLM_MODEL` | Optional | Default `gpt-4.1-mini` |
| `DATABASE_URL` | For accounts | Postgres connection string |
| `JWT_SECRET` | For accounts | 32+ random bytes (`node generate-jwt-secret.js`) |
| `CRON_SECRET` | Optional | Bearer secret for `/api/cron/purge-expired` |
| `TRAINER_ACCESS_CODE` | Optional | When set, every page and API route (except `/api/health`) requires this code via `/access`. Cookie is an HMAC keyed by `JWT_SECRET`, valid 30 days. Unset = no gate |
| `RATE_LIMIT_CALLER_MAX` / `_WINDOW_SEC` | Optional | Per-IP limit on `/api/simulate/*`. Default 30 per 300 s |
| `RATE_LIMIT_GRADING_MAX` / `_WINDOW_SEC` | Optional | Per-IP limit on `/api/evaluate-call`. Default 10 per 3600 s |
| `RATE_LIMIT_TOKEN_MAX` / `_WINDOW_SEC` | Optional | Per-IP limit on `/api/elevenlabs/token`. Default 10 per 3600 s |
| `DEMO_MODE` | Optional | `true` skips login; sessions stay in the browser. Never on a public deployment |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional | Used by `npm run db:seed` to create a platform admin |

### ElevenLabs agent setup
1. In ElevenLabs, create an agent (Agents Platform → Create agent). Any placeholder system prompt and first message will do; they are overridden per call.
2. Open the agent's **Security** tab and enable overrides for **System prompt**, **First message** and **Voice** (the app sends all three).
3. Copy the agent id into `ELEVENLABS_AGENT_ID`, and create an API key (with Agents access) for `ELEVENLABS_API_KEY`.
4. If the agent requires authentication (recommended), the app uses a server-minted token, so nothing public is exposed.
5. Optional: set a `voiceId` per scenario in the editor.

### Database
```bash
createdb call_trainer
# set DATABASE_URL, JWT_SECRET in .env
npm run db:migrate        # prisma migrate deploy
npm run db:seed           # optional platform admin
```

### Scripts
| Script | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | `prisma generate` + production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run db:migrate` / `db:seed` | Apply migrations / seed admin |

## Deployment
See [DEPLOY.md](DEPLOY.md).

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits
Originally based on OpenAI's openai-realtime-agents demo (MIT). See [LICENSE](LICENSE).

> **Rate limits:** counters are in-memory (fixed window) and per server instance. On Vercel/serverless they are best-effort: each warm instance counts separately and cold starts reset them. Use a shared store (e.g. Upstash Redis) for strict enforcement. Requests are also capped at 200 turns / 20,000 transcript characters / 200 KB body to bound LLM cost. `/api/access` attempts are limited to 10 per 15 min per IP.

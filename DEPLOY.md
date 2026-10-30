# Deploying

Any Node 22+ host works (Vercel, Fly, Render, a VPS). You need a Postgres database for accounts.

## Checklist
1. **Database**: provision Postgres; set `DATABASE_URL`. Run `npm run db:migrate` (use the direct, non-pooled URL for migrations on Neon/Supabase). Run it again on every deploy that adds a migration; the team view needs `20261027000000_training_assignments`.
2. **Secrets**: `JWT_SECRET` (`node generate-jwt-secret.js`; it also keys the grade seal and the access-code cookie, so rotating it signs everyone out), `CRON_SECRET`.
3. **Voice**: OpenAI Realtime needs only an OpenAI key (`OPENAI_REALTIME_API_KEY`, or `OPENAI_API_KEY`). ElevenLabs is optional: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, with overrides enabled on the agent (see README). With both, `VOICE_ENGINE` picks the default.
4. **Coach, grading and wizard** (optional): `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`). Check it from Settings, Models after deploying. `OPENAI_API_KEY` stands in for `LLM_API_KEY` only while `LLM_BASE_URL` points at OpenAI; a custom base URL needs its own `LLM_API_KEY`.
5. **Do not set `DEMO_MODE`**. It disables authentication.
6. Build and start: `npm run build && npm start`.
7. **Retention**: `vercel.json` schedules `/api/cron/purge-expired` daily on Vercel, and Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the variable is set. Elsewhere, call it with that header. The route accepts nothing else (the `x-vercel-cron` header is ignored) and returns 401 when `CRON_SECRET` is unset. Per-org retention is set in the database (`Organization.sessionRetentionDays`).
8. **Health**: `GET /api/health` returns `{ ok }` for uptime checks (503 when a required dependency is down). Send `Authorization: Bearer $CRON_SECRET`, or sign in as a platform admin, to see DB, secrets and provider configuration (`elevenlabs`, `realtime`, `llm`).
9. **Proxies**: run the app behind at least one proxy that sets or appends `X-Forwarded-For`. If more than one sits in front of the app, set `TRUSTED_PROXY_HOPS` (see below).

## Client IP behind proxies
Rate limits and audit rows use the client IP from `X-Forwarded-For` (`clientIp` in `src/lib/rateLimit.ts`). Each proxy appends the address it saw to that header, so only the entries your own proxies added can be trusted; anything to their left is whatever the client sent. `TRUSTED_PROXY_HOPS` is the number of proxies that append, and the app reads the entry that many places from the right.

The app must run behind at least one proxy that sets or appends `X-Forwarded-For`. Without one, the header the client sent reaches the app unchanged, so any client can pick its own address and get a fresh bucket for every per-IP limit, including access-code attempts and sign-in. No value of `TRUSTED_PROXY_HOPS` prevents that, and `0` is not valid (it falls back to 1). This covers Node exposed directly, nginx without a `proxy_set_header X-Forwarded-For` line (it passes the client's header through untouched by default), and a TCP or TLS load balancer that adds no HTTP headers.

- **Vercel**: keep the default of 1. Vercel replaces the header with a single entry.
- **One proxy that appends**, such as Fly's edge or nginx with `proxy_add_x_forwarded_for` in front of Node: 1.
- **More than one proxy layer**, for example a CDN in front of Fly, Render or nginx: one per layer, usually 2.
- **Not sure**: send a request from a known IP, log the `X-Forwarded-For` the app receives, and set the variable to your IP's position counted from the right (the last entry is 1). Then send one with `X-Forwarded-For: 203.0.113.9` added. If the app receives only `203.0.113.9`, nothing in front of it appends to the header; add a proxy that does.

Too low, and every visitor shares the CDN's address and its rate-limit bucket. Too high, and clients can choose their own address by sending the header. The value is read as a whole number: `0`, negative numbers and text fall back to 1, and anything after the leading digits is dropped (`2.5` reads as 2). `x-real-ip` is read only when there is no `X-Forwarded-For`.

## Hardening notes
- Rate limiting is in-memory (per instance). Use a shared store if you run multiple instances.
- Security headers and a CSP are set in `next.config.ts`; the CSP `connect-src` allows ElevenLabs and LiveKit. OpenAI Realtime needs no entry: the WebRTC offer goes through `/api/realtime/sdp` on your own origin. Adjust it if you use a regional ElevenLabs endpoint (LLM calls are server-side and unaffected).
- Auth cookies are `httpOnly`, `sameSite=lax` and `secure` in production. Serve over HTTPS.
- Transcripts may contain personal data. Set retention windows and review your privacy obligations.

## Access code and rate limits (Vercel)

1. Project → Settings → Environment Variables: add `TRAINER_ACCESS_CODE` (a long random string) to gate the whole site. Visitors see `/access` and enter it once; the cookie lasts 30 days. Leave it unset for a public deployment. `/api/health` stays open for uptime checks.
2. Keep `JWT_SECRET` set: it keys the access cookie HMAC. Rotating it signs everyone out of the gate.
3. Optional: tune `RATE_LIMIT_CALLER_MAX`, `RATE_LIMIT_GRADING_MAX`, `RATE_LIMIT_TOKEN_MAX`, `RATE_LIMIT_REALTIME_MAX`, `RATE_LIMIT_COACH_MAX`, `RATE_LIMIT_WIZARD_MAX` (and the `_WINDOW_SEC` variants). Defaults per IP: 30/5 min, 10/hour (grading and re-grades together), 10/hour, 10/hour, 120/10 min, 20/hour. The per-account limits are fixed in code; [TESTING.md](TESTING.md#rate-limits) lists them. Leave `TRUSTED_PROXY_HOPS` unset on Vercel.
4. Redeploy after changing env vars. Limits are in-memory per instance (best-effort on serverless); see README.
5. `/api/cron/*` is exempt from the gate (Vercel Cron cannot send the cookie). Instead it requires `Authorization: Bearer $CRON_SECRET`, compared in constant time, so set `CRON_SECRET` or the purge job returns 401.

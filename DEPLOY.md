# Deploying

Any Node 22+ host works (Vercel, Fly, Render, a VPS). You need a Postgres database for accounts.

## Checklist
1. **Database**: provision Postgres; set `DATABASE_URL`. Run `npm run db:migrate` (use the direct, non-pooled URL for migrations on Neon/Supabase).
2. **Secrets**: `JWT_SECRET` (`node generate-jwt-secret.js`), `CRON_SECRET`.
3. **Voice**: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, with overrides enabled on the agent (see README).
4. **Grading** (optional): `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`).
5. **Do not set `DEMO_MODE`**. It disables authentication.
6. Build and start: `npm run build && npm start`.
7. **Retention**: `vercel.json` schedules `/api/cron/purge-expired` daily on Vercel. Elsewhere, call it with `Authorization: Bearer $CRON_SECRET`. Per-org retention is set in the database (`Organization.sessionRetentionDays`).
8. **Health**: `GET /api/health` reports DB, secrets and provider configuration.

## Hardening notes
- Rate limiting is in-memory (per instance). Use a shared store if you run multiple instances.
- Security headers and a CSP are set in `next.config.ts`; the CSP `connect-src` allows ElevenLabs and LiveKit. Adjust it if you use a regional ElevenLabs endpoint or a custom LLM host (LLM calls are server-side and unaffected).
- Auth cookies are `httpOnly`, `sameSite=lax` and `secure` in production. Serve over HTTPS.
- Transcripts may contain personal data. Set retention windows and review your privacy obligations.

## Access code and rate limits (Vercel)

1. Project → Settings → Environment Variables: add `TRAINER_ACCESS_CODE` (a long random string) to gate the whole site. Visitors see `/access` and enter it once; the cookie lasts 30 days. Leave it unset for a public deployment. `/api/health` stays open for uptime checks.
2. Keep `JWT_SECRET` set: it keys the access cookie HMAC. Rotating it signs everyone out of the gate.
3. Optional: tune `RATE_LIMIT_CALLER_MAX`, `RATE_LIMIT_GRADING_MAX`, `RATE_LIMIT_TOKEN_MAX` (and the `_WINDOW_SEC` variants). Defaults: 30/5 min, 10/hour, 10/hour per IP.
4. Redeploy after changing env vars. Limits are in-memory per instance (best-effort on serverless); see README.
5. `/api/cron/*` is exempt from the gate (Vercel Cron cannot send the cookie); it is protected by `CRON_SECRET`.

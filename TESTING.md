# Testing guide

## Start
```bash
npm install
npm run build && npm start     # http://localhost:3000
# or: npm run dev
```
(`npm run build` runs `prisma generate`; it needs no live database, but `DATABASE_URL` must be set to any postgres-shaped URL if it complains.)

## Environment per mode
| Mode | Needs | What works |
|---|---|---|
| **UI-only demo** | `DEMO_MODE=true` | All pages, scenario editor, text simulation (scripted caller), heuristic grading, history in localStorage. No login. |
| **Demo + LLM** | `DEMO_MODE=true`, `LLM_API_KEY` | Above, with a live LLM caller and quote-backed LLM grading. |
| **Voice** | + `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Real voice calls (agent must have overrides enabled, see README). |
| **Full** | + `DATABASE_URL`, `JWT_SECRET`, `npm run db:migrate` | Registration/login, MFA, server-stored sessions. Remove `DEMO_MODE`. |

Example: `DEMO_MODE=true npm run dev`.

## Click-through checklist
1. **Landing (`/`)**: hero, features and example debrief render; no horizontal scroll at 375px; the mobile menu opens/closes.
2. **Demo banner**: with `DEMO_MODE=true` a "Demo mode" strip shows and `/trainer` loads without login.
3. **Not-configured state**: without ElevenLabs keys, `/trainer` auto-selects *Text simulation* and, on the Voice tab, shows "ElevenLabs not configured" with the Start button disabled.
4. **Scenarios (`/trainer/scenarios`)**: three built-ins listed and read-only; *Duplicate* creates "… (copy)"; edit title, persona, a rubric weight, add and remove a criterion; *Save* shows "Saved to this browser"; reload keeps it; *Delete* removes it.
5. **Validation**: clearing the title and saving shows an error and does not save.
6. **Text simulation**: choose a scenario → *Start simulation* → the caller's opening line appears → type 3-5 replies; each gets a reply (scripted or LLM) → *End & grade*.
7. **Debrief**: opens at `/trainer/debrief/local-…` with an overall score, grade, goal result, one card per rubric criterion with score, rationale and quoted evidence taken verbatim from your replies. Without an LLM key a "keyword heuristic" notice shows.
8. **Edge case**: start and immediately end without typing → message "nothing to grade", no redirect.
9. **Dashboard (`/dashboard`)**: the session appears with score; stats update; clicking opens the debrief; the trash icon deletes it.
10. **Voice (needs ElevenLabs)**: Voice tab → *Start call* → allow the mic → the caller greets you with the scenario's opening line in the scenario's persona; the live transcript fills in; Mute works; *End & grade* lands on the debrief.
11. **Auth (full mode only)**: register (new team) → lands on `/trainer`; sign out/in; wrong password shows an error; `/dashboard` while signed out redirects to `/login`; sessions persist across devices.
12. **API sanity**: `GET /api/config` returns capability flags; `GET /api/elevenlabs/token` returns 503 `elevenlabs_not_configured` without keys; `GET /api/health` reports each dependency.

## Run a scenario end to end
1. `DEMO_MODE=true npm run dev` → open `/trainer`.
2. Pick **Inbound lead: leaking water heater**.
3. Text tab → *Start simulation*. Try: "Thanks for calling, this is Sam. How urgent is the leak and where is it?", "What's the age of the unit, and have you shut the water off?", "Can I get your name, address and best callback number?", "There's a diagnostic fee of $89, applied to the repair. I can book you this afternoon between 2 and 4."
4. *End & grade* → verify every criterion has a score and cited quotes.
5. Add `LLM_API_KEY` and repeat: scores become rationale-driven, and every quote must appear in the transcript (unverifiable quotes are dropped).

## Access code and rate limits

- Access gate: run with `TRAINER_ACCESS_CODE=letmein`. Any page redirects to `/access`; `curl -i localhost:3000/api/config` returns 401; `/api/health` returns 200. A wrong code shows an error; the right one sets an httpOnly cookie and lands on the app. Unset the variable and the gate disappears. 11 wrong attempts within 15 min from one IP return 429.
- Rate limits: set `RATE_LIMIT_GRADING_MAX=2`, finish three calls; the third shows "You're going a bit fast…" in the trainer and the response carries `Retry-After`. Same pattern for `RATE_LIMIT_CALLER_MAX` (text mode) and `RATE_LIMIT_TOKEN_MAX` (voice).
- Size caps: a transcript over 200 turns or 20,000 characters is rejected with 400.

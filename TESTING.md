# Testing guide

## Start

```bash
npm ci
DEMO_MODE=true npm run dev        # http://localhost:3000, no login, no keys, no database
```

For a production-like run: `npm run build && npm start`. The build runs `prisma generate` and needs a postgres-shaped `DATABASE_URL` and a 32+ character `JWT_SECRET`; neither has to be live.

## Automated checks

These are what CI runs on every pull request. Run them before the click-through.

```bash
npm run lint
npm run typecheck
npm test                          # Vitest, tests/**/*.test.ts
npm run validate:personas         # 0 errors expected; warnings flag weak scripted replies
npx tsx scripts/coach-smoke.ts    # no-key coach, template wizard and URL guard
```

## Environment per mode

| Mode | Needs | What works |
|---|---|---|
| **Demo, no keys** | `DEMO_MODE=true` | Every page. Scripted caller, rules-based coach, template wizard, heuristic grading, sample team data, history in this browser. No login. |
| **Demo + AI** | add `LLM_API_KEY` (any OpenAI-compatible API) | AI caller in text mode, AI coach cues, AI wizard drafts, quote-backed AI grading, Models page check. |
| **Voice: OpenAI Realtime** | add `OPENAI_REALTIME_API_KEY` or `OPENAI_API_KEY` (or `LLM_API_KEY` when `LLM_BASE_URL` is api.openai.com) | Voice calls. OpenAI Realtime is the default voice engine whenever an OpenAI key is available. |
| **Voice: ElevenLabs** | add `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Voice calls through an ElevenLabs agent with overrides enabled (see README). |
| **Full** | add `DATABASE_URL`, `JWT_SECRET`, `npm run db:migrate`; remove `DEMO_MODE` | Registration, login, MFA, server-stored sessions, real team data and assignments. |

## Click-through checklist

Use `DEMO_MODE=true` with no keys unless a step says otherwise. Check every screen at 375 px wide and on desktop, in light and dark, and by keyboard alone. Nothing should scroll sideways at 375 px.

### 1. Landing and chrome
1. `/` renders the hero ("Practice the price objection before your next call.", Start free, no card, See pricing), the three-turn example session with one coach cue and no score, and the numbered Brief, Call, Debrief steps. No model names, env var names or setup commands appear; the footer links to GitHub and the self-hosting guide. Nothing scrolls sideways at 1440, 768, 390 and 320 px or at 200% zoom, and the page never asks for the microphone. The mobile tab bar shows on phones.
2. With `DEMO_MODE=true` a "Demo mode" strip shows, and `/trainer` and `/library/new` load without login.

### 2. Theme toggle and dark mode
1. The theme toggle cycles "match system", "light" and "dark". Reload: the choice sticks.
2. Set the OS to dark with "match system" selected: browse pages switch to dark.
3. In dark, check the library, wizard, progress, team and Models pages for unreadable text, white panels or missing borders.
4. The live call and the debrief follow the theme: light in light, dark in dark. Printing the debrief uses daylight colors.

### 3. Command palette (Ctrl+K, ⌘K on macOS)
1. Press Ctrl+K (⌘K) on any page: the palette opens with focus in "Search personas, pages and actions".
2. Type part of a persona name, a page ("Progress", "Models") or an action ("New persona with AI"). Arrow keys move, Enter opens, Escape closes and focus returns to where it was.
3. A search with no match shows "No results". The palette is usable at 375 px.
4. On `/trainer`, pick a different persona: the briefing switches to it without a full page reload. Toggle theme from the palette: the header theme icon updates too.

### 4. Library (`/library`)
1. The header reads "54 personas across 18 sales jobs" (more if packs were added).
2. **Start here** shows the reviewed scenarios plus the create tile. Each job family has its own shelf; "View all N" and "Show fewer" expand and collapse it.
3. **Phone shelves**: at 375 px each shelf swipes sideways and snaps card by card; from tablet width up they become grids.
4. **Facets**: Role, Objection type, Difficulty, Call type, Industry and Pack source (Reviewed, Draft (needs review), Mine). Counts update as you combine them; active filters show as chips with a remove button; "Clear all" resets. On phones, **Filters** opens a bottom sheet with a "Show N" button.
5. **Search**: press `/` to focus it. Search matches names, objections and industries. A miss shows "No persona matches yet" with **Build it with AI**.
6. **Sheet**: open a card. It shows the persona, chips, goal, objections with prep answers, talk track and rubric weights. Draft personas show the "Draft persona" notice. Escape closes it and focus returns to the card.
7. **Pack JSON**: in the sheet press **Pack file**. The JSON has no `builtIn` field; **Copy JSON** changes to "Copied".
8. **Practise** on a card and **Pre-flight** in the sheet open `/trainer?scenario=<id>`. **Duplicate & edit** opens a copy in the editor.

### 5. Persona wizard (`/library/new`)
**Template path (no key)**
1. The chip reads "Template drafts (no AI key on this server)". Steps: What you sell, Give context, Review persona, Rubric, Save.
2. Pick a sales job, call type and difficulty, describe the product, then **Next**.
3. Paste CRM notes. On the Product page tab, import `https://example.com`: its text appears. Then try `http://localhost`, `http://169.254.169.254`, `http://10.0.0.1` and `https://example.com:8080`: each is refused with a clear message and nothing is fetched.
4. **Draft persona**: a "Template draft" notice shows, and each field shows its source.
5. Edit fields. On Rubric, change weights so the total is not 100: **Next** stays disabled until it is.
6. Save: **Save and test call** opens the briefing; **Save only** adds it under "Your personas" in the library. **Copy pack JSON** copies JSON with `"status": "draft"`.

**AI path (`LLM_API_KEY` set)**
1. The chip reads "Drafts with <model>". After **Draft persona** it reads "Generated with <model>", and fields reflect the pasted context.
2. Set a wrong key and draft again: the wizard falls back to a template draft and says so. No provider error text is shown.

### 6. Pre-flight briefing (`/trainer?scenario=home-services-inbound-lead`)
1. Persona header, goal, objections (prep answers hidden until you choose to reveal them), talk track and rubric.
2. **Systems check lamps**: "Persona loaded" is green; "Goal read" is off until you tick "Got it"; "Coach" is amber with "Rules-based coach" without a key and green with one; the voice lamp is amber when voice is not configured.
3. **Call mode**: with no voice keys, Voice shows a notice ending "Switch to Text to practise now." and **Start call** is disabled. Text works.
4. **Coach modes**: the dial switches Blind, Guided and Coached, and the help line changes with it.
5. **Test mic** (Voice mode): the browser asks for the mic, the button shows "Listening…" and then "Test again". Deny the permission and check the message says what happened and how to allow it.

### 7. Live call deck
1. **Start call** in Text. The page becomes the call screen in the current theme, site chrome hides, and the caller's opening line appears under "Stay with the buyer.". The header shows the persona, the call time, the status ("Your turn", "Listening" or "Muted" in voice), "Standard voice" or "Premium voice" once the call is minted, and the minutes count from the briefing as "At call start". No vendor or model name appears anywhere.
2. Type replies (Enter sends, Shift+Enter adds a line). Without a key the scripted caller answers from the pack's sample replies.
3. **Rail** (desktop, 1024 px and up): the transcript takes about two thirds; the rail starts with the live scoreboard: the live estimate /100 (labelled "not final"), talk track count and "You talk" share, then the rubric tapes, hatched while provisional and solid once a quote of yours confirms them. Below that: the buyer brief (goal, objections), one next move, the talk track (steps tick) and earlier cues. Scroll the rail to the coach settings: the live estimate stays pinned at the top while the rest scrolls. Your lines carry score chips such as "▲ Discovery questions +12" once a quote confirms a gain.
4. **Cues**: when Dana asks "What does a visit cost?" reply about something else. An Objection cue appears with the prep answer as its suggested line. A reply over about 70 words triggers a Guardrail cue; doing most of the talking triggers a Whisper.
5. **Use line** puts the suggestion in the composer without sending it. **Hide cue** removes the cue, and the coach does not repeat it on the next turns. Only the newest cue shows; an older one never comes back. A new cue is announced politely and never moves focus.
6. **Blind / Guided / Coached**: Blind shows "Blind mode" with no live help (no scoreboard); Guided shows the scoreboard and talk track but no cues; Coached adds the next move. Switching mid-call takes effect on the next turn.
7. **Phone** (390 px and 320 px): the rail is hidden; a score strip in the header (live estimate /100 "not final", talk track, "You talk") stays visible for the whole call without opening anything. "Buyer brief, rubric and coach settings" opens a disclosure with the brief, rubric tapes, talk track, earlier cues and coach mode. The next move docks above the controls; while the brief is open it shrinks to one line ("Close the brief to see it.") and the brief scrolls inside a small cap. At 390x844 and 320x568, with the brief open and a cue showing, nothing overlaps the controls and Tab never lands on a hidden or covered element; on very short screens the middle column scrolls as a whole. Scroll the conversation (or focus it and use the arrow keys) to reach earlier turns. The control bar stays put while replies arrive, clears the home indicator, and never covers the transcript or the focused element. No horizontal scroll at 320 px or at 200% zoom.
8. **End and grade** lands on the debrief. Ending before you have said anything shows "The call ended before you said anything, so there is nothing to grade." and does not save a graded session.

### 8. Debrief (`/trainer/debrief/<id>`)
1. **Next move first**: the top card reads "Practice one better next question." and names your lowest rubric area and its score. Below it, only the parts the grade supports: **Buyer said** (the caller's line at the retry turn, word for word, with a link that moves focus to that turn in the transcript), **What happened** (the grader's note on that area, labelled an interpretation) and **Try saying** (the persona's prep answer for the objection the buyer's line actually raises, labelled a suggestion; absent when no single objection clearly matches that line). The Dana example copy never appears in a real debrief unless you practiced that persona.
2. **Retry from turn N**: the one retry button, in the next move card. It opens the briefing with a retry notice, text mode only, and the call resumes right after that caller line. With no caller line to restart from, the card offers "Practice this persona again" instead.
3. **Score**: beside the next move (below it on phones), not a hero. "Final score" for AI grades, "Score estimate" for rules-based ones, with the grade, the goal outcome (Goal achieved, partly met or missed), what the score means and that it covers this transcript only, and "See the evidence for each score". If no quote in the grade matches its cited turn word for word, a "Not enough evidence" note shows. No improvement percentages.
4. **Evidence jump**: each criterion's quotes link to their transcript turn; Tab to a link, press Enter, and focus lands on the turn with a visible outline. A quote whose wording differs from its turn says "Not an exact quote"; a quote with no turn says "Unverified quote". In the transcript, only exact quotes mark a turn "Evidence for"; a turn cited with different wording reads "Cited for ..., wording differs. Not verified evidence." A criterion without evidence says "No direct transcript evidence found for this criterion."
5. **States**: a deleted or unknown id shows "We couldn't find this session" with **Back to progress**; someone else's session shows "You can't open this session"; a demo session from another browser shows "This session isn't in this browser"; a call with no transcript or where you said nothing shows its own message with **Practice again**; an ungraded call shows "This call wasn't graded" with the transcript below. No vendor, model or setting names appear, including in re-grade errors. Check at 1440, 768, 390 and 320 px and 200% zoom: no sideways scroll.
6. **Re-grade**: with a key, **Re-grade with AI** replaces the heuristic grade and the label reads "Re-graded by AI" (never a model id). If the request fails: "Re-grading failed. Try again in a minute." With a wrong key the grader falls back to rules and the grade is kept: "AI grading didn't work this time, so your grade wasn't changed. Try again in a minute." In demo mode the button shows only on a rules-based grade.
7. **Re-grade rules** (full mode, `LLM_API_KEY` set): a manager or owner of the session's organization, or a platform admin, sees **Re-grade with AI** on every graded call on a library persona, AI-graded ones included. On a call with a custom persona, the button shows only in a browser that holds that persona; elsewhere it is hidden and a direct `PATCH` without the scenario answers 400 `scenario_required`. A trainee sees it only while their own call has no AI grade; on an AI-graded call they see "Think this grade is wrong? Ask your manager to re-grade it.", and a direct `PATCH /api/transcripts/<id>` answers 403 `regrade_not_allowed`. A call longer than 1,000 turns or 120,000 characters is re-graded on its opening turns, and the note under the score says how many were graded. On a server call saved without a grade (for example after the grading limit), the button also shows next to "This call wasn't graded" for the trainee and their manager. Two re-grades a trainee sends at once save one grade: the extra requests get 403 `regrade_not_allowed`, or 409 `conflict` if something else changed the call in the meantime. A manager's concurrent re-grades all save, and the last one wins.
8. **Another buyer for this skill** suggests a persona that targets your weakest criterion; **Open the briefing** opens it.

### 9. Progress (`/dashboard`)
1. With no calls: "No practice calls yet" and **Pick a persona**.
2. After a few graded calls: KPI tiles with **sparklines**, the **score trend** (it appears after two graded calls), the practice-day **heatmap**, skill averages by criterion, and **Practise this next** naming your weakest area.
3. **Assigned to you** lists assignments made in the team view, and marks one done after you complete that persona.
4. Clicking a session opens its debrief; deleting one asks for confirmation.

### 10. Team view (`/team`)
1. In demo mode the page shows sample team data, so it never looks empty.
2. Create an assignment (persona, rep, due date). An invalid due date is rejected with a message. The assignment shows for that rep under "Assigned to you" on the progress page.
3. Full mode: a manager or owner sees only their own organization; a trainee who opens `/team` sees "Team view is for managers" and cannot open another rep's data.
4. **Supervisor notes**: open a note from **Needs attention**, write it and save; the rep sees it on their debrief. In demo mode notes on sample sessions stay in this browser.
5. **Note conflict** (full mode, two manager accounts in two browsers): open the same session's note in both, save in the first, then save in the second. The second shows "Someone changed this note after you opened it. Copy your text, then cancel and open the note again to see their version." and the first note is kept. `PUT /api/sessions/<id>/notes` with a stale `expectedNotesAt` answers 409 `conflict`.
6. **Voice quality** (full mode with an OpenAI key). Premium is gated per organization by `Organization.voiceModelComped`, set by hand in the database. On a comped team an owner sees **Voice quality** with Standard and Premium and can switch it; "Saved" appears and the next voice call starts on the Premium model (the saved session's `realtimeModel` column shows which). Anyone who can't change it sees no panel at all, not a disabled or read-only one: managers and trainees on any team, and owners of a team that is not comped. On a team that is not comped only platform admins see the panel, every call uses Standard even if the stored tier is premium, and `PATCH /api/team/voice` as its owner answers 403 `not_comped`. `GET /api/team/voice` answers with the effective tier in `tier` (Standard unless the team is comped and Premium is selected); only editors also get `selected`, the stored choice, which differs from `tier` when a platform admin sets Premium on a team that is not comped. `PATCH` as a manager or trainee always answers 403. No model id appears anywhere in the panel. Demo mode hides the panel and always uses Standard.

### 11. Models page (`/settings/models`)
1. Without a key the model shows as not set up and no key is configured. **Check connection** explains what to set.
2. With `LLM_API_KEY`: **Check connection** shows "Connected" with the model, or "Connection failed" with a hint (try a wrong key and a wrong `LLM_BASE_URL`). The key itself is never shown.
3. Press **Check connection** repeatedly: it hits its rate limit and says how long to wait.
4. The gear icon in the header and `/settings` both open this page. In demo mode the Security tab explains that MFA needs a database instead of loading forever.

### 12. Voice: OpenAI Realtime
1. Set `OPENAI_REALTIME_API_KEY` (or `OPENAI_API_KEY`). In the briefing choose Voice and **Start call**, then allow the mic.
2. The persona greets you with its opening line; both sides appear in the live transcript; coach cues still arrive; Mute (Space) works; **End & grade** lands on the debrief.
3. In the browser's network tab, `/api/realtime/session` returns a short-lived client secret, never your API key.
4. Without an OpenAI key, `POST /api/realtime/session` returns 503 `realtime_not_configured` and the briefing points you to Text.
5. Quota failover between `OPENAI_API_KEY` and its backups is covered in [OpenAI key failover](#openai-key-failover) below.

### 13. Voice: ElevenLabs
1. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` and leave the OpenAI keys unset (OpenAI Realtime is preferred when an OpenAI key exists).
2. Voice → **Start call** → allow the mic. The caller greets you in the scenario's persona, the transcript fills in, Mute works, and **End & grade** lands on the debrief.
3. Without keys, `GET /api/elevenlabs/token` returns 503 `elevenlabs_not_configured`.

### 14. Accounts (full mode only)
1. Register a new team and land in the app. Sign out and back in. A wrong password shows an error.
2. `/settings/security`: enrol TOTP MFA, sign out, and sign in with the code. A wrong code is rejected.
3. Signed out, `/dashboard` redirects to `/login`. Sessions persist across devices.
4. Google sign-in (needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `DATABASE_URL`): `/login` and `/register` show Continue with Google. With any of the four unset there is no button and `curl -i localhost:3000/api/auth/google/start` returns 404. A new Google account lands in the app on the Free plan; an account with the same email signs in as that user; an account with MFA asks for the authenticator code. With `TRAINER_ACCESS_CODE` set and no access cookie, a new Google user is sent to `/access`. An unverified Google email shows the unverified error; an email whose account is linked to a different Google account fails; Cancel on Google's screen returns to `/login` with a cancelled message. From `/register?plan=pro&interval=year&src=pricing`, a new Google account lands on `/trainer` with the same query.

### 15. API sanity
1. `GET /api/config` returns capability flags and the provider name only, never a key, model id or base URL.
2. `GET /api/health` reports each dependency.
3. **Grade seal** (full mode): grade a call with `POST /api/evaluate-call`, then save it with `POST /api/transcripts`, sending the same transcript, the response minus its `seal` as `evaluation`, and the `seal` beside it. That saves with `"graded": true`. Change `overallScore` and save again: it saves with `"graded": false` and no score.

## Run a scenario end to end
1. `DEMO_MODE=true npm run dev` and open `/library`.
2. Open **Inbound lead: leaking water heater** and press **Pre-flight**.
3. Text mode, Coached. Try: "Thanks for calling, this is Sam. How urgent is the leak and where is it?", "What's the age of the unit, and have you shut the water off?", "Can I get your name, address and best callback number?", "There's a diagnostic fee of $89, applied to the repair. I can book you this afternoon between 2 and 4."
4. Watch the talk track tick and the tapes turn solid. **End & grade**: every criterion has a score, and quotes come from your own lines.
5. Add `LLM_API_KEY` and repeat. Scores come with rationales, and any quote the model returns that is not in the transcript is dropped.

## Access code, rate limits and size caps

### Access code
Run with `TRAINER_ACCESS_CODE=letmein`. Any page redirects to `/access`; `curl -i localhost:3000/api/config` returns 401 `access_code_required`; `/api/health` returns 200. A wrong code shows an error; the right one sets an httpOnly cookie and lands on the app. 11 wrong attempts within 15 minutes from one IP return 429. Unset the variable and the gate disappears.

### Rate limits
Every limit is a fixed window in memory, per server instance, and resets on restart. There are two kinds: per-IP limits, most of which you can tune with `RATE_LIMIT_*` variables, and fixed per-account limits, so a signed-in user can't get past a limit by switching networks. Both apply; whichever runs out first answers 429. The client IP is read from `X-Forwarded-For` as set by `TRUSTED_PROXY_HOPS` (see [DEPLOY.md](DEPLOY.md#client-ip-behind-proxies)). The `RATE_LIMIT_*` limits, `/api/access` and the Models check answer with a `Retry-After` header and `{ "error": "rate_limited", "message": ... }`, and the UI shows the message.

**Per IP.** Set a low value, restart, and go past it.

| Route | Variable (default) | How to trigger |
|---|---|---|
| `/api/simulate/turn` (text caller) | `RATE_LIMIT_CALLER_MAX` (30 per 300 s) | Set 3 and send four replies in a text call |
| `/api/evaluate-call` (grading) and `PATCH /api/transcripts/[id]` (re-grade), shared | `RATE_LIMIT_GRADING_MAX` (10 per 3600 s) | Set 2 and grade three calls: the third shows "You're going a bit fast…" |
| `/api/coach/turn` (live coach) | `RATE_LIMIT_COACH_MAX` (120 per 600 s) | Set 3 and keep talking: after the third turn the rail shows the wait message, and the call itself carries on |
| `/api/persona/generate` + `/api/persona/fetch-url` (wizard, shared) | `RATE_LIMIT_WIZARD_MAX` (20 per 3600 s) | Set 2, import a URL twice, then **Draft persona** |
| `/api/realtime/session` (OpenAI Realtime voice) | `RATE_LIMIT_REALTIME_MAX` (10 per 3600 s) | Set 1 and start two voice calls |
| `/api/elevenlabs/token` (ElevenLabs voice) | `RATE_LIMIT_TOKEN_MAX` (10 per 3600 s) | Set 1 and start two ElevenLabs calls |
| `/api/usage/heartbeat`, `/api/usage/end`, `/api/usage/credit` (voice metering) | `RATE_LIMIT_USAGE_MAX` (1200 per 600 s) | Full mode only. Set 3, then `curl` `/api/usage/end` four times with a signed-in cookie |
| `/api/billing/checkout` + `/api/billing/portal` + `/api/billing/premium` + `/api/billing/seats` (Stripe, shared) | `RATE_LIMIT_BILLING_MAX` (20 per 3600 s) | Needs `STRIPE_SECRET_KEY=sk_test_...`. Set 2 and press **Choose Pro** three times |
| `PATCH /api/team/voice` (voice quality) | `RATE_LIMIT_TEAM_SETTINGS_MAX` (30 per 3600 s) | Full mode only, as the owner of a comped org. Set 1 and switch Standard and Premium twice |
| `/api/auth/google/start` + `/callback` (Google sign-in, shared) | `RATE_LIMIT_GOOGLE_MAX` (30 per 900 s) | Needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`. Set 2 and `curl -i` the start route three times |
| `/api/llm/check` (Models page) | fixed, 6 per 10 min | Press **Check connection** seven times |
| `/api/access` | fixed, 10 per 15 min | See Access code above |
| `/api/auth/login`, `/api/auth/register`, `/api/auth/mfa/challenge` | fixed, 10, 5 and 10 per minute | Full mode only. These answer with their own error text |

Each `_MAX` has a matching `_WINDOW_SEC`.

**Per account.** Fixed in code. The wizard, grading, re-grade, Models check and team limits also send `Retry-After` and a message; the others answer 429 without `Retry-After`.

| Route | Limit |
|---|---|
| `/api/persona/generate` + `/api/persona/fetch-url` (wizard, shared) | 20 per hour |
| `/api/evaluate-call` | 10 per minute |
| `PATCH /api/transcripts/[id]` (re-grade) | 5 per 10 minutes |
| `/api/llm/check` | 20 per hour |
| `/api/coach/turn` | 60 per minute |
| `/api/simulate/turn` | 40 per minute |
| `/api/realtime/session` | 6 per minute |
| `/api/realtime/sdp` | 10 per minute |
| `/api/usage/*` (heartbeat, end, credit) | 60 per minute |
| `/api/billing/checkout` + `/api/billing/portal` + `/api/billing/premium` + `/api/billing/seats` (shared) | 20 per hour |
| `/api/elevenlabs/token` | 20 per minute |
| `POST /api/transcripts` (save a session) | 30 per minute |
| `GET /api/transcripts/[id]/voice` (debrief voice label, tier only) | 60 per minute |
| `PUT /api/sessions/[sessionId]/notes` | 30 per minute |
| `/api/team/overview` | 60 per minute |
| `POST` and `DELETE /api/team/assignments` | 20 per minute |
| `/api/auth/mfa/enroll`, `/activate`, `/disable` | 10, 8 and 6 per minute |
| `GET /api/cron/openai-keys` (key slot health) | 30 per minute per platform admin, or per IP for the cron bearer, with `Retry-After` |

A quick wizard check with curl (demo mode skips login):

```bash
RATE_LIMIT_WIZARD_MAX=2 DEMO_MODE=true npm run dev
for i in 1 2 3; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/persona/fetch-url \
    -H "content-type: application/json" -d '{"url":"https://example.com"}'
done                              # 200, 200, 429
```

### Size caps
- The text caller rejects a history over 200 turns or 20,000 characters with 400. The live coach sends only the most recent turns of a long call, so it keeps working. Grading and re-grades read the first 1,000 turns and 120,000 characters, and the debrief notes when a call was longer instead of refusing it.
- A request body over 200 KB is rejected with 400:

```bash
node -e 'process.stdout.write(JSON.stringify({ url: "x".repeat(250000) }))' |
  curl -s -i -X POST localhost:3000/api/persona/fetch-url -H "content-type: application/json" --data-binary @-
```

## OpenAI key failover

`npx vitest run tests/openai-key-failover.test.ts tests/openai-key-health.test.ts` covers everything below without real keys or network. The tests stub `fetch` with `vi.stubGlobal` and answer per `Authorization` header, so each key slot can return a different reply. Fixture keys are random placeholders built at runtime. To simulate a quota failure, return `new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429 })` for one slot and a normal reply for the next. Never use real keys to test this.

1. **Slots**: `OPENAI_API_KEY`, `OPENAI_API_KEY_BACKUP_1`, `OPENAI_API_KEY_BACKUP_2`, in that order. Unset, blank and duplicate values are skipped.
2. **Triggers**: only an allowlisted quota, billing or deactivation `error.code` or `error.type` (`OPENAI_QUOTA_ERROR_CODES` in `src/lib/openaiKeys.ts`) with status 400, 401, 403 or 429, from the exact OpenAI host. The request is sent once more on the next slot.
3. **Not triggers**: ordinary 429s (`rate_limit_exceeded`, `slow_down`, no code, empty or HTML body), any 5xx, network errors, timeouts, 401 `invalid_api_key`, 403, 404 and 400. Each sends exactly the requests it sent before. The 400 `temperature` retry stays on the same slot and runs before classification.
4. **Exhausted**: chat throws `LLM_QUOTA_EXHAUSTED` and the coach, grader, wizard and text caller fall back as on any LLM error; a re-grade answers 502 `llm_failed`. Voice answers 503 `realtime_unavailable` with `Retry-After: 300`. The Models check shows the 429 hint plus "All configured OpenAI keys are out of quota. Check billing."
5. **Cooldown**: an exhausted slot is skipped for 15 minutes, then tried first again. Its first success logs `openai_key_recovered`.
6. **Boundaries**: an explicit `LLM_API_KEY` (chat and check) or `OPENAI_REALTIME_API_KEY` (voice) is used alone. A custom `LLM_BASE_URL`, including a look-alike such as `https://api.openai.com.attacker.example`, never gets a slot key.
7. **Logs**: one JSON line per event, slot numbers only: `openai_key_failover`, `openai_key_exhausted`, `openai_key_recovered` (`console.warn`) and `openai_key_served` (`console.info`, once per successful chat, voice or check request on the ladder).

**Key slot health route.** `GET /api/cron/openai-keys` reads this instance's memory only: no OpenAI call, no state change, `Cache-Control: no-store`. It lives under `/api/cron/` because the access-gate exemption for `/api/health` is an exact match.

| Caller | Result |
|---|---|
| No session | 401 |
| Wrong bearer, or `x-vercel-cron` alone | 401 |
| Signed-in trainee, manager or owner who is not a platform admin | 403 |
| Platform admin | 200 |
| `Authorization: Bearer $CRON_SECRET` | 200 |
| Demo mode, any caller | 404 |
| Over 30 a minute | 429 with `Retry-After` |

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/openai-keys
```

## Voice minute metering: limits and residual risk

Full mode with `DATABASE_URL` only. `npx vitest run tests/usage-hardening.test.ts tests/usage-reconcile.test.ts` covers everything below without a database.

- **Reservations.** A call reserves its minutes (up to 60) when it is minted, and that is its maximum billable length. Open calls reserve Premium minutes too, so concurrent calls cannot all pick Premium. A Premium call reserves only the Premium minutes it holds (its whole reservation, and so its `maxSeconds` is the smaller of the normal allowance and the Premium minutes left), because a provider session cannot change engine mid-call: it is stopped when those run out and the next call is minted on the standard engine. Under one whole Premium minute (60 s) left, the call starts on Standard.
- **Premium Voice entitlement.** Read from the database at every mint: 40 Premium minutes per Pro account or Team unit (min(add-on quantity, seats)), out of the plan's own minutes, only while the subscription is `active` (never during a Stripe trial), the add-on quantity is above 0 and the stored period end is in the future. `past_due` (even inside the base plan's grace), `unpaid`, `canceled`, `incomplete` and an expired period mint Standard on the next call. Paid Premium at mint also needs `PREMIUM_VOICE_ON_SALE=true`; with it off every paid call is Standard. A comped organization on Premium runs Premium whatever the flag says, without using these minutes. A seat change made in the Billing Portal is followed by a webhook-driven update that sets the add-on quantity back to the seats (more seats prorated on the next invoice, fewer seats with no credit), only while on sale. Mint receipts are sealed (AES-GCM) and carry no readable model. `npx vitest run tests/premium-voice.test.ts tests/premium-addon.test.ts tests/premium-no-model.test.ts` covers this without a database or Stripe.
- **Premium Voice purchases.** Off unless `PREMIUM_VOICE_ON_SALE=true`. To walk it in test mode: set it with a Stripe test key, open **Settings > Billing** as a Pro subscriber or Team owner, check the plan and seat summary at the top of the Premium voice row, press **Add Premium voice**, check the review (effective date, prorated charge today, new renewal total and date, what changes), then **Confirm and pay**, or **Back** to leave it unchanged. **Remove at period end** shows "Falls back to Standard on <date>". With the flag unset the row reads "Coming soon (not on sale yet)" and the routes answer 400 `premium_not_available`.
- **Premium voice trial call.** Off unless `PREMIUM_TRIAL_SAMPLE_ON=true` (exact; independent of `PREMIUM_VOICE_ON_SALE`). Each Free organization gets ONE Premium voice call over OpenAI Realtime, ever: it is claimed on the organization (`premiumTrialCallUsedAt`, `premiumTrialCallSessionId`) when the call is minted, before OpenAI is asked for a secret, so a failed mint, an abandoned call, another member, a new session or signing in again never gets a second one. Not offered to org-less accounts, Pro or Team subscribers (including Stripe `trialing`), lapsed paid accounts still linked to a subscription, accounts with the add-on flag, or comped organizations, and never on ElevenLabs. The call is capped at 5 minutes (a lower existing deadline still wins) and ends with the usual "This call reached the maximum call length." It uses the Free plan's ordinary minutes, never the paid Premium minutes; daily and minute caps apply as usual. To walk it: sign in as a member of a Free organization with a database and `USAGE_CAPS=on`, start a voice call (the deck shows **Premium voice** and the trial notice), then start another (**Standard voice**); the debrief header shows the same labels. `npx vitest run tests/premium-trial.test.ts` covers it without a database or keys.
- **A period reset mid-call.** The call's length is shared out between the old and the new period. The old part goes to the ledger as `voice_call_prior` and the new part to the current period, which holds the minutes for it from the moment of the reset.
- **Rollover and settlement.** A rollover swaps only if the period and `version` it read are unchanged, and otherwise starts again. A settlement writes only if the period it was worked out for is still current, and otherwise rolls back and retries (`StaleAllowanceError`). Periods only move forward. `usage-reconcile.test.ts` replays both interleavings against the in-memory database.
- **No standard engine.** With `ELEVENLABS_AGENT_ID_STANDARD` unset, only accounts with Premium Voice and Premium minutes left can start an ElevenLabs call. Everyone else gets 503 `standard_voice_not_configured`. Set the standard agent to serve them.

**Residual risk: a running provider session is not ended by the server.** Neither OpenAI Realtime nor ElevenLabs is asked to end a live session from here. Both connect straight from the browser, and the ephemeral secret and token are only checked while the session is set up. I did not find a server-side termination call in either integration, and I did not confirm against the providers' current docs whether one exists. A modified client can therefore keep a session open after the server has stopped billing it, and the provider's own usage (not ours) is what grows. What is in place:

1. Billing is clamped to the reservation, so the user is never charged for more than they reserved.
2. A call is marked `abuseFlagged` and an `usage.abuse_flagged` audit event is written when the server sees it outlive its reservation: the client keeps sending heartbeats more than 60 seconds after a `cap_reached` or `max_duration` stop, or reports the end more than 60 seconds after the reservation ran out. Calls the server already settled as silent (`heartbeat_timeout`) are covered too: a heartbeat or end event for one after its reservation ran out is flagged, and so is a silent call that is only reaped after its reservation ran out.
3. A flagged user gets 429 `voice_blocked` with `Retry-After` from both mint routes for 10 minutes.

What this does not cover: a client that goes silent and never contacts the server again looks the same as a closed tab until something reaps it. A real closed tab that is only reaped more than a minute after its reservation would have ended is flagged too, so that user waits 10 minutes before the next call. Compare the provider's usage dashboard with the ledger if you see unexplained spend, and treat a provider-side session limit or sideband hang-up as the real fix.

To check by hand: start a call, stop it from the server side by waiting out the reservation (lower `MAX_RESERVE_MINUTES` locally), keep heartbeating for more than a minute, and the next `/api/realtime/session` answers 429 `voice_blocked`.

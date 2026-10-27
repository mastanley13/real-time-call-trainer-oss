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
1. `/` renders the hero, features and example debrief. The mobile tab bar shows on phones.
2. With `DEMO_MODE=true` a "Demo mode" strip shows, and `/trainer` and `/library/new` load without login.

### 2. Theme toggle and dark mode
1. The theme toggle cycles "match system", "light" and "dark". Reload: the choice sticks.
2. Set the OS to dark with "match system" selected: browse pages switch to dark.
3. In dark, check the library, wizard, progress, team and Models pages for unreadable text, white panels or missing borders.
4. The live call and the debrief always use the dark deck, whatever the theme. Printing the debrief uses daylight colors.

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
1. **Start call** in Text. The page turns into the dark deck, site chrome hides, and the caller's opening line appears.
2. Type replies (Enter sends, Shift+Enter adds a line). Without a key the scripted caller answers from the pack's sample replies.
3. **Copilot rail** (desktop): rubric tapes are hatched while provisional and turn solid once a quote of yours confirms them; talk-track steps tick; "You talk" shows your share.
4. **Cues**: when Dana asks "What does a visit cost?" reply about something else. An Objection cue appears with the prep answer as its suggested line. A reply over about 70 words triggers a Guardrail cue; doing most of the talking triggers a Whisper.
5. **Use line** puts the suggestion in the composer without sending it. **Dismiss** removes the cue, and the coach does not repeat it on the next turns.
6. **Blind / Guided / Coached**: Blind shows "Blind mode" with no live help; Guided shows the estimate and talk track but no cues; Coached shows cues too. Switching mid-call takes effect on the next turn.
7. **Phone coach sheet** (375 px): the rail is hidden, the latest cue docks above the composer, and tapping it opens the Coach sheet. Opening the sheet moves focus to its close button and Tab stays inside it. **Use line** in the sheet inserts the line, closes it and puts focus in the composer; the close button, Esc and a tap outside also close it, and focus returns to the coach button. Esc with the sheet open does not open the end-call dialog.
8. **End & grade** lands on the debrief. Ending before you have said anything shows "The call ended before you said anything, so there is nothing to grade." and does not save a graded session.

### 8. Debrief (`/trainer/debrief/<id>`)
1. Score ring, outcome (Goal achieved, partly met or missed), and a grader label: "rules-based" without a key.
2. **Moment strip**: click a turn and the transcript scrolls to it. ▼ marks coach cues; colored turns carry scored evidence.
3. **Evidence jump**: each criterion's quotes link to their transcript line. A criterion without evidence says "No direct transcript evidence found for this criterion."
4. **Retry from turn N**: opens the briefing with a retry notice, text mode only, and the call resumes right after that caller line.
5. **Re-grade**: with a key, **Re-grade with AI** replaces the heuristic grade and the label shows the model. If the request fails: "Re-grading failed. Try again in a minute." With a wrong key the grader falls back to rules and the grade is kept: "AI grading didn't work this time, so your grade wasn't changed. Try again in a minute." In demo mode the button shows only on a rules-based grade.
6. **Re-grade rules** (full mode, `LLM_API_KEY` set): a manager or owner of the session's organization, or a platform admin, sees **Re-grade with AI** on every graded call on a library persona, AI-graded ones included. On a call with a custom persona, the button shows only in a browser that holds that persona; elsewhere it is hidden and a direct `PATCH` without the scenario answers 400 `scenario_required`. A trainee sees it only while their own call has no AI grade; on an AI-graded call they see "Think this grade is wrong? Ask your manager to re-grade it.", and a direct `PATCH /api/transcripts/<id>` answers 403 `regrade_not_allowed`. A call longer than 1,000 turns or 120,000 characters is re-graded on its opening turns, and the note under the score says how many were graded. On a server call saved without a grade (for example after the grading limit), the button also shows next to "This call wasn't graded" for the trainee and their manager. Two re-grades a trainee sends at once save one grade: the extra requests get 403 `regrade_not_allowed`, or 409 `conflict` if something else changed the call in the meantime. A manager's concurrent re-grades all save, and the last one wins.
7. **Next drill** suggests a persona that targets your weakest criterion; **Start this drill** opens it.

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

### 13. Voice: ElevenLabs
1. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` and leave the OpenAI keys unset (OpenAI Realtime is preferred when an OpenAI key exists).
2. Voice → **Start call** → allow the mic. The caller greets you in the scenario's persona, the transcript fills in, Mute works, and **End & grade** lands on the debrief.
3. Without keys, `GET /api/elevenlabs/token` returns 503 `elevenlabs_not_configured`.

### 14. Accounts (full mode only)
1. Register a new team and land in the app. Sign out and back in. A wrong password shows an error.
2. `/settings/security`: enrol TOTP MFA, sign out, and sign in with the code. A wrong code is rejected.
3. Signed out, `/dashboard` redirects to `/login`. Sessions persist across devices.

### 15. API sanity
1. `GET /api/config` returns capability flags and the model id only, never a key or base URL.
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
| `/api/elevenlabs/token` | 20 per minute |
| `POST /api/transcripts` (save a session) | 30 per minute |
| `PUT /api/sessions/[sessionId]/notes` | 30 per minute |
| `/api/team/overview` | 60 per minute |
| `POST` and `DELETE /api/team/assignments` | 20 per minute |
| `/api/auth/mfa/enroll`, `/activate`, `/disable` | 10, 8 and 6 per minute |

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

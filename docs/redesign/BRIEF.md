# UI Council brief: Real-Time Call Trainer redesign

Every agent in the council reads this first. It describes exactly what the app is today, what it must become, and how proposals are judged.

## 1. The app today

**Repo:** `C:\Users\Mykel\projects\real-time-call-trainer-oss` (public: github.com/mastanley13/real-time-call-trainer-oss, live: real-time-call-trainer-oss.vercel.app). MIT licensed, by Mykel Stanley. Forked in spirit from OpenAI's `openai-realtime-agents` demo.

**What it does:** a rep practises a sales or service phone call against an AI persona (voice over ElevenLabs Agents WebRTC, or a typed text simulation), then gets a debrief graded against a weighted rubric, with every score backed by verbatim transcript quotes.

**Stack:** Next.js 15 App Router, React 19, Tailwind 3 with a handful of custom component classes in `src/app/globals.css` (`.card`, `.btn-primary`, `.input`, `.badge`...), lucide-react icons, Inter + Sora fonts, `@elevenlabs/react` for voice, three.js / react-three-fiber for the call orb, zod, Prisma/Postgres (optional accounts, orgs, MFA, supervisor notes). Grading and the text caller use any OpenAI-compatible API (default `gpt-4.1-mini`). No component library: everything is hand-rolled Tailwind.

**Design tokens today** (`tailwind.config.ts`): background `#F8FAFC`, ink `#071827`, primary blue `#1D4ED8`, accent teal `#14B8A6`, line `#E2E8F0`, radius 12/16px, soft card shadows, a fade-up entrance and a breathing orb. Light mode only.

**Screens** (screenshots in `docs/redesign/current/`, desktop 1440px and mobile 390px):

| File | Screen | What is there |
|---|---|---|
| `*-01-landing.png` | `/` | Hero "Practice the call before it counts", fake call card with orb + example debrief bars, 4 feature cards, footer |
| `*-02-scenario-editor.png` | `/trainer/scenarios` | Left list of scenarios, right long form: title, industry, difficulty, persona name/role/behavior/opening line/voice id, trainee goal, call script, rubric rows with weights, scripted replies. Built-ins are read-only, duplicable. Stored in localStorage |
| `*-03-trainer-precall.png` | `/trainer` | Scenario `<select>` dropdown (only 3 built-ins: water-heater inbound lead, roof quote follow-up, "price too high" SaaS objection), badges, goal, collapsible talk track + rubric, and a card with a blurry gradient orb, persona name, Voice/Text toggle, "Start simulation" |
| `*-04-live-call.png` | `/trainer` in call | Orb + persona header, chat-bubble transcript, text input, timer, mute, red "End & grade", talk-track side drawer. **No live coaching, no live scoring**: the persona is forbidden to coach, and nothing on screen reacts to how the rep is doing until the call ends |
| `*-05-debrief.png` | `/trainer/debrief/[id]` | Score ring with letter grade, summary, goal status, Strengths / Areas to improve cards, dark "suggested next step" bar, one card per rubric criterion (bar, rationale, quotes), full transcript. One long vertical scroll |
| `*-06-dashboard.png` | `/dashboard` | 4 stat tiles (sessions, average, best, time practised) and a plain list of past calls with score badges |

Also present: `/login`, `/register`, `/access` (access-code gate), `/settings/security` (MFA), a sticky glass header with Trainer / Scenarios / Dashboard links.

**Honest diagnosis:** it is clean but generic. It reads as a default Tailwind SaaS template: white cards on slate, blue buttons, a blurry orb. Nothing about it says "cutting-edge AI voice coaching." The live call screen is a chat app. Scenario choice is a dropdown with three items. There is no persona library, no persona creation help, no live coaching, no progress story beyond four numbers, and no manager or team surface in the UI even though the data model supports orgs.

## 2. What it must become

The owner wants to submit this project to **OpenAI's Codex open source fund** (up to $25K in API credits for open-source projects that use Codex CLI and OpenAI models) and the **Codex for Open Source** program (ChatGPT Pro with Codex, Codex Security, API credits for projects that use Codex in PR review, maintainer automation and release workflows). Reviewers see the repo, the README, the live demo and how the project uses OpenAI models. A redesign must make the project look like a serious, modern, contributor-friendly open-source AI product that showcases OpenAI models (e.g. Realtime API voice, GPT models for grading, coaching and persona generation).

The redesign is a **total UI change**: a new design system or UI library choice plus a coherent new look and interaction model across every screen. Not a restyle of one page or component.

Non-negotiable product needs the new UI must serve:

1. **Coach and score active calls.** During a live call the UI must be able to coach the rep in real time (whispered cues, next-best-question, objection alerts, talk-track progress) and show live scoring against the rubric, then a strong post-call debrief with evidence. Meeting this exactly is the baseline; doing it brilliantly is above baseline.
2. **Persona library for every sales job, at the open-source level.** A large, browsable, pre-built library of personas and scenarios spanning sales roles and industries (SDR cold calls, AE discovery, SaaS, insurance, mortgage, real estate, solar, home services, auto, medical devices, B2B procurement, recruiting, retail, customer success, collections...), with filtering by role, industry, difficulty and objection type, plus an **AI persona wizard** that builds a new persona and scenario from context the user provides (a job description, a product page URL, CRM notes, an ICP, a pasted call). This ships in the open-source core.
3. Everything the app already does keeps working: voice and text modes, editable rubrics, evidence-backed grading, dashboard, accounts/teams, mobile.

## 3. How proposals are judged

Design categories, 1-10:
- **A. Look:** user-friendly, modern, sleek, cutting edge.
- **B. User experience as a whole.**
- **C. Unique design** that feels like cutting-edge tech but still meets the basic needs of an effective sales training app.

Basic-needs categories, on a baseline scale where **5.0 = exactly meets the standard**, 4.9 and below = falls short, 5.1 and above = exceeds it (range 1-10):
- **D. Live call coaching and scoring:** can it actually coach and score active calls?
- **E. Persona library and AI wizard:** the multi-facet pre-built persona library for all sales jobs, at the open-source level, plus the AI wizard that creates personas from context.

Business viability, 1-10 with 5 = neutral. Be decisive and opinionated:
- **F1. As a SaaS app**
- **F2. Selling to entities** (licensing or enterprise deals with sales orgs, training companies, call centers)
- **F3. Not worth it at all** (10 = not worth building, 1 = clearly worth it)

## 4. Research tools

- **Mobbin** (real app screens and flows): load with ToolSearch `select:mcp__0877b270-7705-4557-b9e5-e07868c1bbab__search_screens,mcp__0877b270-7705-4557-b9e5-e07868c1bbab__search_flows,mcp__0877b270-7705-4557-b9e5-e07868c1bbab__search_sections`. Use `platform: "web"` (or `"ios"` for mobile patterns), `output_destination: "doc"`, small `limit` (6-8). Cite `mobbin_url`s.
- **Firecrawl** (web search and page scrape): `mcp__3723ec17-156b-4dad-a49d-d47f71929682__firecrawl_search` and `mcp__3723ec17-156b-4dad-a49d-d47f71929682__firecrawl_scrape` (load with ToolSearch if not present). Use for UI library docs, design-system sites, competitor products (Gong, Second Nature, Hyperbound, Yoodli, Orum, Nooks...).
- The repo itself: read any file under `src/` if you need detail.

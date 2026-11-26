# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned, not in 1.0.0 unless merged before tagging:
- GHL lifecycle events (signup, first graded call, upgrade, went quiet) via an outbox table and cron, off by default. (pending: STR-714, not yet in a PR; third fix pass in progress)
- Per-user minute ledger with hard monthly caps enforced in the database (Free 20, Pro 200, Team 300 pooled per seat, no overages). (pending: STR-685 and STR-715, not yet in a PR)
- First-run UX fixes from STR-709: UX-1 onboarding, UX-2 mobile Start order, UX-3 first-call baseline score, UX-4 mobile talk track. (pending: STR-709, not yet in a PR)
- First graded call is framed as your baseline, the pricing criterion recognizes stated prices and fees, and the debrief lists relative strengths and specific fixes. (pending: PR #21 at 22ffe63, draft, STR-718; Codex round 2 request_changes; negation follow-up open)
- Public pricing and SEO pages, plus signup that requires the access code while the invite gate is on. (pending: PR #19 at 4a7a18d, draft; signed off by Prism, Triage and Codex; merges in the go-live window)
- Stripe checkout for paid plans, with usage metering off when billing is off. Work in progress. (pending: PR #20 at fa21b85, draft; time-limit spec still open; paid plan lines gated by STR-715)
<!-- Free-minutes claim gated by STR-685; paid plan lines gated by STR-715. Anything not merged by tag day moves here. -->

## [1.0.0] - [DATE: day Mykel approves]

First public release.

### Added
- Persona library: 54 personas (3 original scenarios plus 17 job-family packs), filterable by role, industry, difficulty, objection type and call type, stored as validated pack files.
- AI persona wizard (`/library/new`) that builds a persona, objection bank and rubric from a job description, product page URL, CRM notes, ideal customer profile or pasted call, with a template fallback when no LLM key is set.
- Live coach rail with Blind, Guided and Coached modes: live rubric estimate, talk-track progress, talk ratio, and one cue at a time with a "Use line" action that never auto-sends. Rules-based coach when no LLM key is set.
- Voice practice over OpenAI Realtime (WebRTC, default when an OpenAI key is set; standard calls use `gpt-realtime-2.1-mini` by default, premium calls use `gpt-realtime-2.1` via new `REALTIME_MODEL_PREMIUM`, `REALTIME_MODEL` still overrides ([pending merge of #12](https://github.com/mastanley13/real-time-call-trainer-oss/pull/12))) or ElevenLabs Agents, with engine choice and mic test. Text simulation mode with a scripted caller fallback.
- Black-box debrief: score ring, outcome stamp, moment strip, transcript-linked evidence, grader label, re-grade, retry from turn N, and next-drill suggestion.
- Progress logbook: KPI sparklines, score trend, practice-day heatmap, skill averages and a "practise this next" drill.
- Team view (`/team`) for managers and owners: KPIs, rep-by-criterion heatmap, coaching queue, supervisor notes with conflict detection, persona assignments with due dates, and roster CSV export.
- Model settings page (`/settings/models`) with a one-token connection check.
- Command palette (Ctrl K or Cmd K).
- Optional accounts and teams on Postgres and Prisma: org join codes, TOTP MFA, retention purge job.
- Demo mode (`DEMO_MODE=true`) that runs without a database, LLM key or voice provider.
- Optional `TRAINER_ACCESS_CODE` gate for private deployments.
- Google sign-in (OAuth with PKCE), manager-scoped teams (`User.managerId`), onboarding, and team personas (`TeamPersona`). ([pending merge of #10](https://github.com/mastanley13/real-time-call-trainer-oss/pull/10))
- Per-invite access codes with labels, expiry, redemption limits and revocation. ([pending merge of #14](https://github.com/mastanley13/real-time-call-trainer-oss/pull/14))
- Undo for deletes, scenario duplicate and delete, demo reset, skip link, and mobile-friendly call controls.
- CI on pull requests, Vitest test suite (791 tests), persona validation script, Dependabot, issue and PR templates.
- Docs: README, DEPLOY, TESTING, CONTRIBUTING, SECURITY, AGENTS, persona pack guide, and Contributor Covenant 2.1 Code of Conduct.

### Changed
- `DEMO_MODE=true` is refused in production unless `ALLOW_PUBLIC_DEMO=true`; auth fails closed and `/api/health` returns 503 in that state. DEPLOY.md gains a Neon Postgres setup section. ([pending merge of #15](https://github.com/mastanley13/real-time-call-trainer-oss/pull/15))
- New UI built around a live copilot rail beside the call.
- Grader feedback rewritten as natural second-person coaching, with grader versioning and partial goal credit.
- Long calls are graded on their opening turns with a note instead of being refused.

### Fixed
- Grading consistency and layout shift during grading.
- Reply truncation, hang-up handling and message queue issues on calls.
- Toast timing and placement, call card height on mobile, and orb animation smoothness.

### Security
- Spend kill switch: `PAID_FEATURES_ENABLED=false` turns off every paid-provider route (503 `paid_features_off`, text calls fall back to the scripted caller). Optional `DAILY_REALTIME_MINUTES_CAP` sets a per-UTC-day voice budget. Both off by default. ([pending merge of #11](https://github.com/mastanley13/real-time-call-trainer-oss/pull/11))
- Public `/api/health` returns only `{ ok }`; detailed checks need `CRON_SECRET` or admin. ([pending merge of #13](https://github.com/mastanley13/real-time-call-trainer-oss/pull/13))
- Grades are sealed server-side so stored scores cannot be forged; trainees cannot re-roll an AI grade.
- Custom-persona scores are kept out of team KPIs, heatmaps and the coaching queue; assignments accept library personas only.
- Per-IP and per-user rate limits, request size caps, and proxy-aware client IP (`TRUSTED_PROXY_HOPS`).
- Constant-time `CRON_SECRET` check; OpenAI key never sent to custom LLM URLs.
- ReDoS and DNS-rebinding fixes in product URL import (SSRF protections); open-redirect fix on `/access`.

[Unreleased]: https://github.com/mastanley13/real-time-call-trainer-oss/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mastanley13/real-time-call-trainer-oss/releases/tag/v1.0.0

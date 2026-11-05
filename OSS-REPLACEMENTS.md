# OSS model label neutralization: replacement list

Branch: `anvil/oss-neutral-model-labels` (base `c70d127`). Goal: the open-source build never shows a model id to a user, in a page, an API response or an error. Provider names (OpenAI, OpenAI Realtime, ElevenLabs) stay. Backend defaults stay in `src/lib/serverConfig.ts`, `src/lib/realtime.ts`, `src/lib/llm.ts` and the env (`LLM_MODEL`, `REALTIME_MODEL`, `REALTIME_MODEL_STANDARD`, `REALTIME_TRANSCRIBE_MODEL`) and are only sent upstream to providers.

No migration, env, pricing, Stripe or billing changes.

Note: the AirPets reference files (`/workspace/ct-launch/anvil/airpets/REPLACEMENTS.md`, `.../airpets/repo` at `8be3965`, and `/workspace/ct-launch/triage/check-airpets-11-postmerge-8be3965.md`) were outside the permissions granted to this session, so this patch was written from this repo alone. It has not been diffed against AirPets #11.

## The six landing `gpt-4.1-mini` hits

Outside the backend default (`serverConfig.ts`), `src` had exactly six `gpt-4.1-mini` occurrences. All six are gone:

| # | File | Before | After | Rendered? |
|---|---|---|---|---|
| 1 | `src/app/page.tsx` (MODELS, Live coach) | `gpt-4.1-mini (default)` | `Your chat model` | Yes, landing chip |
| 2 | `src/app/page.tsx` (MODELS, Grading) | `gpt-4.1-mini (default)` | `Your chat model` | Yes, landing chip |
| 3 | `src/app/page.tsx` (MODELS, Persona wizard) | `gpt-4.1-mini (default)` | `Your chat model` | Yes, landing chip |
| 4 | `src/components/landing/HeroDeck.tsx` (SAMPLE coach result) | `model: "gpt-4.1-mini"` | field removed | Shipped in the landing client bundle |
| 5 | `src/components/call/Deck.tsx` (doc comment) | `"Text · gpt-4.1-mini"` | `"Text · AI"` | No, comment |
| 6 | `src/contexts/AuthContext.tsx` (doc comment on `Capabilities.model`) | `(e.g. "gpt-4.1-mini")` | field removed | No, comment |

The same landing block also had `gpt-realtime-1.5 (default)` on the Voice card. It now reads `OpenAI Realtime`. The heading "Which model does what" is now "What runs each job", and the paragraph says outputs show whether AI or a fallback produced them, and names `LLM_MODEL` as the switch.

## API shape: before and after

### `GET /api/config` (unauthenticated, behind the optional access gate only)

Before:
```json
{ "demoMode": false, "elevenlabs": true, "realtime": true, "voiceEngines": ["openai", "elevenlabs"],
  "realtimeModel": "gpt-realtime-1.5", "llm": true, "database": true, "billing": false, "hosted": false,
  "model": "gpt-4.1-mini", "provider": "openai" }
```
After:
```json
{ "demoMode": false, "elevenlabs": true, "realtime": true, "voiceEngines": ["openai", "elevenlabs"],
  "llm": true, "database": true, "billing": false, "hosted": false, "provider": "openai" }
```
`model` and `realtimeModel` are removed from `getCapabilities()` itself, so `/api/health` and every other caller lose them too.

### `POST /api/llm/check`

Before: `{ ok, latencyMs, model, status, hint }`. `hint` named the model on success (`Connected. The key works and gpt-4.1-mini answered.`) and on 404 (`This key can't use the model gpt-4.1-mini, ...`).

After: `{ ok, latencyMs, status, hint }`, built field by field. Hints:
- success: `Connected. The key works and the configured model answered.`
- 404: `This key can't use the configured model, or the endpoint doesn't exist. Set LLM_MODEL to a model your account can use, and check LLM_BASE_URL.`
- all other hints were already model-free. The provider body (which often says ``The model `x` does not exist``) is still never read into the response or the log. The 429 and 401 route errors are unchanged and model-free.

### Other responses that carried a model id

| Route | Before | After |
|---|---|---|
| `POST /api/realtime/session` 200 | `{ clientSecret, expiresAt, model, voice, callId?, maxSeconds? }` | `{ clientSecret, expiresAt, voice, callId?, maxSeconds? }`. The client never read `model`. |
| `POST /api/realtime/session` 400/404 upstream | `Check that REALTIME_MODEL (gpt-realtime-1.5) and REALTIME_VOICE are valid.` | `Check that REALTIME_MODEL, REALTIME_MODEL_STANDARD and REALTIME_VOICE are valid.` (`realtimeUpstreamMessage(status)` lost its `model` parameter.) |
| `POST /api/coach/turn` | `CoachResult.model` set on AI updates | field removed from the type and the output |
| `POST /api/persona/generate` | `WizardOutput.model` set on AI drafts | field removed from the type and the output |
| `POST /api/evaluate-call`, `PATCH /api/transcripts/[id]` | `Evaluation.model` set on AI grades (also sealed and stored) | not set. `Evaluation.model?` stays on the type for legacy rows only |
| `GET /api/transcripts/[id]` | returned the stored evaluation as is | strips a legacy `evaluation.model` (`withoutModelId` in `gradable.ts`) |
| Re-grade audit event (server-side DB only) | `metadata.model` from the evaluation | `metadata.model` from `llmModel()`, so operators keep provenance. `previousModel` unchanged |

Other routes checked: `simulate/turn`, `elevenlabs/token`, `realtime/sdp` and `llm.ts` errors already reported status codes only and never passed provider bodies on.

## UI copy replacements

| Where | Before | After |
|---|---|---|
| Header chip (`SiteHeader`, `modelChip.ts`) | `{capabilities.model}`; shown only when a model was reported | `AI on`; shown when `llm` is true (same hosted/admin gating) |
| Settings, Provider panel | `Model: gpt-4.1-mini` chip | `Model: Set by LLM_MODEL on the server` (or `Not in use`) |
| Settings, check result | model chip | removed |
| Settings, jobs table | model id per job | `AI model` per job (`jobRows`) |
| Settings, voice engines | realtime model chip; labels could come from the payload | provider label only (`OpenAI Realtime`, `ElevenLabs voice agent`), never read from the payload |
| Settings intro | "the model that runs it" | "whether AI runs it ... Keys, model ids and endpoint URLs stay on the server" |
| Briefing, voice lamp | `gpt-realtime-1.5 over WebRTC.` | `OpenAI Realtime over WebRTC.` |
| Briefing, coach lamp | `AI coach on gpt-4.1-mini` | `AI coach is on for this call.` |
| Trainer, coach rail chip | `Coach: gpt-4.1-mini · p50 1.2s` | `Coach: AI · p50 1.2s` |
| Trainer, grading label | `Graded by gpt-4.1-mini after the call` | `Graded by AI after the call` |
| Trainer, text caller chip | `Text · gpt-4.1-mini` | `Text · AI` |
| Persona wizard chip | `Drafts with gpt-4.1-mini` / `Generated with gpt-4.1-mini` | `Drafts with AI` / `Generated with AI` |
| Persona wizard pack preview | `Generated with gpt-4.1-mini · structured JSON...` | `Generated with AI · structured JSON...` |
| Debrief, score panel | `Graded by gpt-4.1-mini on the full transcript` / `(model not recorded)` | `Graded by AI on the full transcript` |
| Debrief, live coach panel | `gpt-4.1-mini · p50 1.2s` | `AI · p50 1.2s` |
| Debrief, grader footer and re-grade toast | `Grader: gpt-4.1-mini` / `Re-graded by gpt-4.1-mini.` | `Grader: AI` / `Re-graded by AI.` (`graderLabel` returns `AI` or `rules-based`) |

Docs whose contract statements became false were corrected in one line each: `AGENTS.md` (Secrets section), `SECURITY.md` (`/api/config` sentence), `TESTING.md` (re-grade label, `/api/config` check).

## Tests

- `tests/no-model-labels.test.ts` (new on this branch; open PR #61 adds a file with the same name):
  - pattern self-test: catches `gpt-5*`, `gpt-4.1*`, `gpt-4o*`, `gpt-realtime*`, `o3`/`o4*`, `whisper-1`, `tts-1*`, `gemini-*`, `eleven_*`, `claude-*`, and leaves provider names and env var names alone;
  - source scan of all of `src` (pages, components, API routes, error strings) with an exact three-file backend allowlist, no route or error allowlist;
  - no client code reads `capabilities.model`, `capabilities.realtimeModel` or `result.model`; `llmModel()` is read only by `llm.ts`, `serverConfig.ts`, `llm/check` and the re-grade audit;
  - rendered landing HTML has no model ids and still names OpenAI Realtime and ElevenLabs;
  - `GET /api/config` JSON: exact key set, no `model`/`realtimeModel`, no ids with known ids, a private custom model name and a custom base URL, and with no keys;
  - `POST /api/llm/check` JSON and `console.warn` output, for a known id and a private model name: success (provider echoes the model), no key, HTTP 400/401/403/404/429/500/503 with a provider body naming the model, a non-chat 200 echoing the model, network error and timeout whose thrown messages name the model. Each asserts the exact key set and a specific hint.
- Updated: `grader.test.ts` (no model in grades, audit keeps it, legacy GET strip, neutral `graderLabel`, check route, settings helpers), `realtime.test.ts` (session JSON, upstream 400 naming the model), `usage-hardening.test.ts`, `regrade.test.ts`, `pricing-footer-chip.test.ts`, `coach.test.ts`, `wizard.test.ts`.

## Open PR overlap (from `oss-labels-job/open-pr-files.json`)

- **#61** (voice tier): overlaps almost every file here and also adds `tests/no-model-labels.test.ts`, so that file is an add/add conflict. #61 also adds `src/lib/voiceModels.ts`; if that file holds model ids it will fail the new scan and needs a deliberate allowlist decision (it should be server-only).
- **#56** (icons): `page.tsx`, `ModelsClient.tsx`, `Briefing.tsx`, `Deck.tsx`, `HeroDeck.tsx`, `PersonaWizard.tsx`, debrief page, `TESTING.md`. Mostly line-adjacent icon edits; expect small textual conflicts.
- **#36** (LLM roles): `serverConfig.ts`, `hints.ts`, `llm/check`, `models.ts`, `coach.ts`, `grader.ts`, `personaWizard.ts`, trainer/briefing/debrief, and adds `textModel.ts`/`voiceModel.ts` plus `tests/model-surfaces.test.ts`. Its intent (showing per-role models) conflicts with this patch's intent, not just its lines.
- **#40** (BYOK): `serverConfig.ts`, `llm/check`, `coach.ts`, `grader.ts`, `personaWizard.ts`, `models.ts`, `transcripts/[id]`, `grader.test.ts`. New `llmModel()` callers would trip the new guard test.
- **#55** (realtime hangup): `realtime/session/route.ts`, `realtime.ts`, `realtime.test.ts`, `usage-hardening.test.ts`, `AGENTS.md`, `SECURITY.md`, `TESTING.md`.
- **#59** (first run): `TrainerClient.tsx`, `Deck.tsx`, debrief page, `sessionStore.ts`. **#57**: `page.tsx`. **#58**: `AuthContext.tsx`, `TESTING.md`. **#39**: `llm/check`, session route, `transcripts/[id]`, `grader.test.ts`, `regrade.test.ts`, docs. **#37**: session route, `transcripts/[id]`. **#31**, **#29**, **#28**, **#25**: older PRs touching `page.tsx`, the session route, `SiteHeader.tsx`, `AuthContext.tsx`, the debrief page and `Briefing.tsx`; likely stale.
- PRs #11 to #24 were not inspected file by file.

## Merged into #61 (voice tier)

- `src/lib/voiceModels.ts` (server-only tier to Realtime model mapping) is the one added entry in the scan's exact-file allowlist. The guard also checks that it starts with `import "server-only"` and that its only importer is the server-only `voiceTierServer.ts`.
- `POST /api/realtime/session` 200 is `{ clientSecret, expiresAt, voice, sessionId, receipt?, callId?, maxSeconds? }`, with no `model`. `getCapabilities()` has no `realtimeModel`.
- `receipt` is AES-256-GCM, not a readable signed payload: the minted model is encrypted under a key derived with HKDF from `JWT_SECRET`, with the user id and the call id (`sessionId`) bound as additional data, and padded to one fixed length for every tier. `POST /api/transcripts` still logs the model at most once, on that call's own row.
- The upstream 400/404 message names `REALTIME_MODEL_STANDARD`, `REALTIME_MODEL`, `REALTIME_MODEL_PREMIUM` and `REALTIME_VOICE`, never a value.

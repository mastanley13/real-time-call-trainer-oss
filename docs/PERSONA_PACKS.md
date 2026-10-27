# Persona packs

The persona library is plain data. Each sales job family has one pack file in `src/lib/personas/<family>.ts` that exports an array of `Scenario` objects. `src/lib/personas/index.ts` imports every pack, checks each entry against `ScenarioSchema` (from `src/lib/scenarios.ts`) when the app loads, rejects duplicate ids and exposes the result as `LIBRARY`. CI runs `npm run validate:personas`, which applies the same schema plus stricter pack rules.

A pack entry is the whole practice call: who the persona is and how they behave, the talk track the rep follows, the objections they will hear, the rubric they are graded on, and the scripted lines the caller uses when no AI key is configured.

## How a pack is used

| Part of the app | Fields it reads |
|---|---|
| Library cards, facets and search (`/library`) | `title`, `industry`, `role`, `callType`, `difficulty`, `durationMin`, `objections[].type`, `status`, `aiPersona.name` |
| Persona sheet and **Pack file** view | Everything; the JSON shown is what you submit |
| Pre-flight briefing (`/trainer`) | `aiPersona`, `traineeGoal`, `objections` (prep answers stay hidden until the rep asks), `callScript`, `rubric` |
| AI caller (voice or text, with a key) | `aiPersona` (name, role, behavior, openingLine, voiceId, realtimeVoice), `industry`, `callScript` (as private context; the persona never reveals it) |
| Scripted caller (text, no key) | `aiPersona.openingLine`, `aiPersona.name`, `sampleReplies` |
| Live coach (`/api/coach/turn`) | `rubric`, `callScript` steps, `objections` (line and prep answer) |
| Grader and debrief | `rubric`, `traineeGoal`; the next-drill suggestion matches `role` and `objections[].type` |

## Schema reference

Limits come from `ScenarioSchema`. "Validator" marks rules that only `npm run validate:personas` enforces.

| Field | Type and limits | Notes |
|---|---|---|
| `id` | string, 1 to 80 | Unique across the library. Validator: pack ids start with the family id, for example `insurance-renewal-premium-jump`. Use lowercase kebab case. |
| `title` | string, 1 to 120 | Card headline: call type plus situation, for example `Renewal: homeowner shocked by a 41% premium increase`. |
| `industry` | string, up to 80 | Free text shown as the Industry facet. Reuse an existing spelling from the same pack where you can. |
| `difficulty` | `easy` \| `medium` \| `hard`, default `medium` | Difficulty should come from the situation (stakes, number of objections, how much the persona hides), never from who the persona is. |
| `role` | string, up to 40, default `general` | Validator: must be a `JOB_FAMILIES` id (table below). It also decides which pack file the entry lives in. |
| `callType` | one of `CALL_TYPES`, default `inbound` | See the table below. |
| `durationMin` | number, 1 to 60, default 6 | Typical call length shown on cards. |
| `callScript` | string, up to 6000 | The talk track. One step per line, numbered `1.`, `2.` ... (`-` and `*` bullets also parse). `talkTrackSteps()` turns it into the steps the briefing lists and the live coach ticks off. Validator: must not be empty. Aim for 5 to 7 observable steps. |
| `aiPersona.name` | string, 1 to 80 | Fictional full name. |
| `aiPersona.role` | string, up to 200 | One line: who they are and why they are on the call. |
| `aiPersona.behavior` | string, up to 3000 | The persona's private brief, written in the second person ("You are..."). Give concrete facts and numbers, say which facts they reveal only when asked, what makes them agree, and what makes them resist. Mention each objection so the AI caller actually raises it. |
| `aiPersona.openingLine` | string, up to 500 | The first thing the persona says. |
| `aiPersona.voiceId` | string, up to 80, optional | ElevenLabs voice id override. Leave it out unless you have a reason. |
| `aiPersona.realtimeVoice` | string, up to 40, optional | OpenAI Realtime voice for this persona, one of `REALTIME_VOICES` in `src/lib/realtime.ts` (`alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`). Leave it out to use the server's `REALTIME_VOICE` (default `marin`); an unknown name falls back the same way. |
| `traineeGoal` | string, up to 1000 | What a win looks like, in observable terms. |
| `rubric` | 1 to 12 criteria | Each criterion: `id` (1 to 60, unique; snake_case), `name` (1 to 120), `description` (up to 600; observable behaviour the grader can quote), `weight` (0 to 100). Validator: weights sum to exactly 100 (use whole numbers) and ids are unique. |
| `objections` | up to 8 | Each: `type` (one of `OBJECTION_TYPES`), `line` (1 to 300, the words the persona says), `prepAnswer` (up to 400, what a good rep could say). Validator: at least one objection; warns when a prep answer is empty. |
| `sampleReplies` | up to 20 strings, each up to 500 | Lines the scripted caller uses when there is no AI key. Validator: warns below 4 and when no line covers price, availability, objection or closing (details below). |
| `status` | `reviewed` \| `draft` | **The schema defaults to `reviewed`, so pack entries must set `status: "draft"` explicitly.** Only maintainers change it to `reviewed`. Drafts show a "Draft persona" notice and the "Draft (needs review)" facet. |
| `builtIn` | boolean, optional | Runtime flag. `index.ts` sets it on every library entry, so you can leave it out (the exported pack JSON omits it). Existing packs include `builtIn: true`; either is fine. |

### `JOB_FAMILIES`

| `role` id | Label | Pack file |
|---|---|---|
| `sdr` | SDR cold calls | `sdr.ts` |
| `ae` | AE discovery | `ae.ts` |
| `cs` | Customer success & renewals | `cs.ts` |
| `home-services` | Home services | `home-services.ts` |
| `insurance` | Insurance | `insurance.ts` |
| `mortgage` | Mortgage & lending | `mortgage.ts` |
| `real-estate` | Real estate | `real-estate.ts` |
| `solar` | Solar & energy | `solar.ts` |
| `auto` | Auto sales | `auto.ts` |
| `medical` | Medical devices | `medical.ts` |
| `procurement` | B2B procurement | `procurement.ts` |
| `recruiting` | Recruiting | `recruiting.ts` |
| `retail` | Retail & consumer | `retail.ts` |
| `collections` | Collections | `collections.ts` |
| `financial` | Financial advising | `financial.ts` |
| `logistics` | Logistics & freight | `logistics.ts` |
| `telecom` | Telecom & utilities | `telecom.ts` |
| `general` | General sales | none yet (the built-in "price is too high" scenario lives in `scenarios.ts`) |

Adding a family is a bigger change: open an issue first. It means a new entry in `JOB_FAMILIES`, a new pack file, and an import in the `PACKS` list in `personas/index.ts`.

### `CALL_TYPES`

`inbound` (Inbound), `cold` (Cold call), `discovery` (Discovery), `follow_up` (Follow-up), `renewal` (Renewal), `negotiation` (Negotiation), `collections` (Collections), `service` (Service).

### `OBJECTION_TYPES`

`price` (Price), `timing` (Timing), `competitor` (Competitor), `authority` (Authority), `trust` (Trust), `status_quo` (Status quo), `need` (No need).

## How objections and prep answers feed the live coach

The coach runs after every finished turn and returns at most one cue for the rep. The persona never sees it.

- **Rules-based coach (no key).** After each caller turn it compares the caller's latest line with every objection `line` by shared keywords (half or more of the objection's keywords and at least two of them, or any three). If nothing matches, it falls back to built-in patterns per objection type. When an objection is detected and the rep's next reply does not engage with it (a per-type answer pattern, or at least two keywords from the `prepAnswer`), the coach raises an **Objection** cue. Its suggested line is your `prepAnswer` (clipped to 300 characters), it links to the closest rubric criterion, and its key is `objection:<type>` so it does not repeat.
- **AI coach (with a key).** The whole objection bank, including prep answers, is in the coach prompt, and the coach is told to use prep answers when they fit.
- **Briefing.** "Expect these objections" lists each line; the prep answer stays hidden until the rep chooses to see it, so they think first.

What this means when you write a pack:

1. Write each objection `line` the way the persona will actually say it, and repeat that wording (or close to it) in one of the `sampleReplies` so the scripted caller raises it too.
2. Write `prepAnswer` as one or two sentences the rep can say out loud, in the first person. It becomes the **Use line** suggestion, so it must be honest and compliant on its own.
3. Use the right `type`. It drives the facet, the cue headline and which rubric criterion the cue links to.
4. Give the rubric a criterion about handling objections (the coach looks for names and descriptions mentioning objections, pricing, value, timing, trust, stakeholders or need).

## `sampleReplies` and the no-key scripted caller

Without an AI key, `src/lib/scriptedCaller.ts` plays the persona. For each rep turn it detects intents (asking for a name, phone, address, price, availability, handling an objection, closing, greeting) and answers with the first unused sample reply that fits; if nothing fits it uses the next unused reply in order, and falls back to a short generic line when it runs out. Each reply is used once.

The validator checks that at least one reply matches each hint:

| Hint | A reply counts when it contains |
|---|---|
| price | cost, fee, price, `$`, expensive, pay, quote, afford |
| availability | today, tomorrow, afternoon, morning, works, schedule, show up, appointment, time |
| objection | still, but, other, higher, budget, think, competitor, cheaper, too |
| closing | thanks, thank you, great, sounds good, bye |

The scripted caller also answers contact questions from replies that contain a phone number in `555-0142` form or a street address like `42 Maple Court`. If your talk track collects contact details, include one of each.

Aim for 6 to 8 replies, ordered the way the call naturally unfolds, ending with a closing line. Use fictional details only: `555-01xx` numbers, invented street names, no real companies or people.

## Draft to reviewed checklist

New and changed personas start as `draft`. A maintainer flips them to `reviewed` after checking all of this. Reviewers (and Codex review) use the same list.

**Mechanics**
- [ ] `npm run validate:personas` reports 0 errors and 0 warnings.
- [ ] `id` is `<role>-<short-slug>`, `status` is `"draft"`, the entry sits in the right family file.
- [ ] A text call in `DEMO_MODE=true` with no key works: the scripted caller raises each objection and the coach cues it.

**Realism and coaching value**
- [ ] The behavior brief has concrete facts and numbers, says what the persona hides until asked, and what moves them.
- [ ] The talk track has 5 to 7 numbered, observable steps.
- [ ] Every rubric criterion describes something the grader can quote from the rep's words. Weights reflect what matters most on this call.
- [ ] `traineeGoal` is specific and checkable.
- [ ] Prep answers are things a strong rep would say, not slogans.

**Stereotypes and bias**
- [ ] No traits, attitudes or difficulty tied to age, gender, ethnicity, nationality, religion, disability, accent, class or family status.
- [ ] No written-out accents, dialect spellings or "broken English".
- [ ] Names are varied across the pack without being used as shorthand for behaviour.
- [ ] Hostility is proportionate to the situation and never targets the rep's identity. No slurs or harassment.
- [ ] Hardship (debt, illness, job loss) is portrayed with dignity, and the rubric rewards empathy.

**Regulated industries** (insurance, mortgage and lending, financial advising, collections, medical devices; also financing and tax claims in solar, auto and telecom, fair-housing rules in real estate, and employment rules in recruiting)
- [ ] Nothing promises or guarantees approval, rates, coverage, returns, savings, tax outcomes or clinical results. Prices are estimates with the conditions stated.
- [ ] The talk track and rubric reward the disclosures a compliant rep makes (for example "estimate subject to underwriting", "coverage starts once bound and paid"), and reward declining when the persona pushes for a promise.
- [ ] Collections calls verify identity before discussing a debt, use no threats or false urgency, and offer options.
- [ ] Recruiting calls never ask about protected characteristics; real estate calls never steer by neighbourhood demographics; medical device calls make no off-label claims.
- [ ] The pack does not cite statutes or claim that practising it makes a rep compliant. This is training content, not legal advice.

**Privacy**
- [ ] No real customer data, real call transcripts, real companies used without permission, or real people.

## Exporting from the wizard

The AI persona wizard at `/library/new` builds a complete entry from a few picks and optional context.

1. **What you sell**: pick the sales job (a `JOB_FAMILIES` id), call type and difficulty, and describe the product and industry.
2. **Give context** (optional): paste a job description, CRM notes, an ideal-customer profile or a call, or import a public product page by URL (fetched server-side through the SSRF guard). Remove names, numbers and other personal data before you paste a call; the text is sent to the configured AI provider.
3. **Draft persona**: with an AI key the wizard drafts with your model; without one it assembles a template draft from your picks and context. Each field shows where it came from.
4. **Review persona** and **Rubric**: edit anything. The rubric total must reach 100.
5. **Save**: choose **Keep it private** (saved to this browser) or **Contribute it as a pack** and press **Copy pack JSON**.

Before you paste the JSON into a pack file:

- Change `id` from the generated `custom-...` value to `<role>-<short-slug>`.
- Keep `"status": "draft"`.
- Fill gaps the validator reports, usually `sampleReplies` coverage.

To fix an existing persona, open it in the library, press **Pack file** to see its JSON, and edit the entry in its pack file directly.

## Pull request flow

1. Fork the repo and create a branch such as `persona/insurance-renewal-premium-jump`.
2. Add your entry to the end of the array in `src/lib/personas/<role>.ts` (the JSON from the wizard is a valid TypeScript object literal).
3. Run `npm run validate:personas`, `npm run typecheck` and `npm test`.
4. Run `DEMO_MODE=true npm run dev`, open the persona from `/library`, and practise it once in text mode with no key. Check the opening line, that each objection comes up, and that the coach cues it.
5. Open a pull request. Fill in the template, including the checklist above. If you are asking for a persona rather than writing one, use the **Persona request** issue form instead.
6. CI runs the validator, and Codex review (when the maintainers have enabled it) comments on bias, compliance and schema issues. A maintainer reviews and merges it as a draft, then marks it `reviewed` once the checklist passes.

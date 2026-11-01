# Grading regression fixtures

Each `*.json` file here is one practice-call transcript plus the grade the production grader gave it. `scripts/grade-regression.ts` grades every fixture several times with the baseline model and with each candidate model, then applies the pass rules in `scripts/grade-regression-eval.ts`. A candidate may become `LLM_MODEL_GRADE` only if every rule passes.

The script needs provider keys, so it never runs in CI or in `npm test`. Run it by hand against a Preview deployment's environment with a Neon branch, never against production. (The script itself does not touch the database.)

## Fixture format

```json
{
  "id": "tally-weak-r1",
  "kind": "weak_no_contact",
  "scenarioId": "home-services-inbound-lead",
  "source": "where the transcript came from",
  "notes": "what is notable about the recorded grade",
  "recorded": {
    "score": 4, "letter": "F", "goal": "not_achieved",
    "criteria": { "greeting": 12, "discovery": 3, "capture": 2, "fee": 0, "close": 5 },
    "infoCapture": 2, "grader": "claude-sonnet-5-5", "graderVersion": "llm-v2"
  },
  "transcript": [
    { "role": "assistant", "text": "the caller's line" },
    { "role": "user", "text": "the trainee's line" }
  ]
}
```

- `role` follows the app: `assistant` is the AI caller, `user` is the trainee.
- `kind` decides how a fixture counts:
  - `weak_no_contact`: the trainee never asked for contact details. Rule (c) requires that no run of a candidate gives these information-capture credit (more than 10 out of 100).
  - `name_only`: the trainee asked only for a name. Partial credit is correct, so these are not part of rule (c).
  - `contact_captured`: the trainee asked for contact details and the caller gave them.
- `scenarioId` must be a built-in or library persona id. The criterion ids in `recorded.criteria` are that persona's rubric ids.
- `recorded` is what the production grader said at the time. The script grades fresh against the baseline model and compares candidates with that fresh baseline; `recorded` is the reference for a human reading a failure.

## Building fixtures from Tally's transcripts

Tally saves each QA run in `/workspace/ct-launch/tally/` (`hall-raw.md`, `grader-hallucination-repro.md`, `prism-60d-session.md`). For each complete transcript:

1. Copy the turns in order. Tally writes `T1 DANA:` and `T2 YOU:`, or numbered `assistant` and `user` lines. Dana, the caller, is `assistant`. The trainee ("YOU") is `user`.
2. Where a note abbreviates a line with `...`, restore the full line from elsewhere in the same file. Skip the run if you cannot.
3. Copy the recorded score, letter and per-criterion scores. `infoCapture` is the `capture` criterion's score.
4. Set `kind` from what the trainee asked for, as above.
5. Use fictional names only. Callers use `555-01xx` numbers and made-up addresses. Replace any real person's name, such as the trainee's, with a fictional one and say so in `notes`. Do not commit `.tally-src/` or any other copy of Tally's notes.

## Current fixtures

Nine fixtures from the water heater scenario: six weak calls with no contact asked, two where only the name was asked, and one strong-ish call where all contact details were captured (60 D).

The grader-hallucination ticket asks for 10 weak "no contact asked" runs. Tally's notes hold six complete ones, so four more are needed. Play the call as in `grader-hallucination-repro.md` (4 trainee turns such as "Hi, how can I help?" / "ok" / "we can probably look at that" / "alright, thanks, bye"), at desktop and mobile width, and add each as `tally-weak-<n>.json`.

## Running the regression

```bash
npx tsx --conditions=react-server scripts/grade-regression.ts \
  --baseline claude-sonnet-5-5 \
  --candidates gpt-6.1-terra,gpt-6-luna \
  --provider claude-sonnet-5-5=https://api.anthropic.com/v1,ANTHROPIC_KEY \
  --provider gpt-6.1-terra=https://api.openai.com/v1,OPENAI_API_KEY \
  --provider gpt-6-luna=https://api.openai.com/v1,OPENAI_API_KEY \
  --out /workspace/ct-launch/tally
```

`--provider model=baseUrl,ENV_NAME` names the environment variable that holds that model's key, so keys never appear on the command line. Check a candidate's exact model id against the provider's model list before running (for example the Claude Haiku 5.5 id). The report for each candidate is written to `grade-regression-<model>.md` in `--out`.

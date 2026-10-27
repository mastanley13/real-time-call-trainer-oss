## What changed

<!-- The user-visible change, in a sentence or two. Link the issue it closes. -->

## Why

## How I tested

<!-- Commands you ran and the TESTING.md sections you walked. Say what you could not test (for example voice without keys). -->

## Checklist

CI runs the first five on every pull request.

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run validate:personas` (0 errors)
- [ ] `npm run build` with a dummy postgres `DATABASE_URL` and `JWT_SECRET`, or the CI build is green
- [ ] Walked the relevant [TESTING.md](https://github.com/mastanley13/real-time-call-trainer-oss/blob/main/TESTING.md) section with `DEMO_MODE=true` and no keys
- [ ] New or changed pure logic has a Vitest test in `tests/`
- [ ] UI: colors only through design tokens, works at 375 px, in dark mode and by keyboard; copy is sentence case with no em dashes
- [ ] API routes: `requireAuth`, zod validation, rate limits on cost-bearing and write routes, org scoping, no secrets or raw provider errors in responses or logs
- [ ] No secrets, `.env` files or real customer data in the diff
- [ ] Docs updated (README env table, TESTING.md, AGENTS.md) if behaviour or config changed

### Persona packs (delete if not relevant)

- [ ] Entry is in `src/lib/personas/<role>.ts`, its id starts with `<role>-`, and `status` is `"draft"`
- [ ] `npm run validate:personas` shows 0 warnings for it
- [ ] Practised once in text mode without a key: each objection comes up and the coach cues it
- [ ] Passes the bias and regulated-industry checks in [docs/PERSONA_PACKS.md](https://github.com/mastanley13/real-time-call-trainer-oss/blob/main/docs/PERSONA_PACKS.md#draft-to-reviewed-checklist)
- [ ] All names, numbers and addresses are fictional

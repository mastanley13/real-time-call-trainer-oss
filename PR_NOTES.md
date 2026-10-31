# PR notes

## Team MFA gate (PR #24, item 2)

The enforcement toggle lives on PR #24, not this branch. When #24 and this branch meet, the toggle must call
`isTeamPlan(org)` from `src/lib/usagePlan.ts` to decide whether it is unlocked.

- `isTeamPlan` is true only when `org.planTier === "team"`.
- `planTier` is written only by the Stripe webhook sync (`reconcile` and `applyEntitlement` in `src/lib/billing.ts`).
  No other code path sets `team`. Do not add one, and do not gate the toggle on seat count, a client flag or a role.
- A cancel or unpaid subscription drops the org to `free`, so the toggle locks again through the same helper.

## Prices

Prices are resolved by lookup key with `stripe.prices.list({ lookup_keys })` (`resolvePriceIds` in `src/lib/billing.ts`).
The `STRIPE_PRICE_*` env vars are gone. No key, secret or price id is stored in code, tests, docs or commit messages.

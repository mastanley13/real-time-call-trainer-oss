# PR notes

## Team MFA gate (PR #24, item 2)

The enforcement toggle lives on PR #24, not this branch. When #24 and this branch meet, the toggle must call
`isTeamPlan(org)` from `src/lib/usagePlan.ts` to decide whether it is unlocked.

- `isTeamPlan` is true only when `org.planTier === "team"`.
- `planTier` is written only by the Stripe webhook sync (`reconcile` and `applyEntitlement` in `src/lib/billing.ts`).
  No other code path sets `team`. Do not add one, and do not gate the toggle on seat count, a client flag or a role.
- A cancel or unpaid subscription drops the org to `free`, so the toggle locks again through the same helper.

## Plan sync reads product metadata

What a subscription grants comes from its own items, not from the current lookup-key prices
(`entitlementFromItems` in `src/lib/billing.ts`). `retrieveSubscription` expands `items.data.price.product`.

- The tier is the product's `metadata.plan`, exactly `pro` or `team`. Missing or any other value grants nothing.
- A lookup key that contradicts the product (team key on a pro product, or the reverse), or two products declaring
  different plans on one subscription, grants nothing.
- An archived price, or one whose lookup key moved to a replacement, still resolves through its product.
- A subscription whose status is no longer paid (unpaid, canceled and so on) drops its holder to free even when
  its items declare no valid plan.
- Premium Voice is a flag only: a `calltrainer_premium_*` lookup key, or product metadata `plan=premium` or
  `addon=premium_voice`. It never sets a tier.

Needs confirming in the Stripe test dashboard: the Pro product must carry `metadata.plan=pro` (Team already has
`plan=team`), or Pro purchases will be ignored. The Premium product's metadata was not in the ticket; if the lookup key
ever moves off an archived Premium price, set `addon=premium_voice` on its product so the flag keeps syncing.

## Prices

Prices are resolved by lookup key with `stripe.prices.list({ lookup_keys })` (`resolvePriceIds` in `src/lib/billing.ts`).
The `STRIPE_PRICE_*` env vars are gone. No key, secret or price id is stored in code, tests, docs or commit messages.

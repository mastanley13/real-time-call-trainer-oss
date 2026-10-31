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

## Free cap: 10 voice minutes a month, checked at call start only

- `FREE_MINUTES` is 10. The month resets on the user's existing usage anchor (signup day), not the calendar month.
- Only the start of a voice call checks the cap. A Free call runs to its normal end, is billed for every minute, and may
  leave `minutesUsed` above 10. The next voice start answers 402 `cap_reached` (use Text or upgrade), before any charge.
- New column `TrainerSession.capEnforced` (migration `20261031040000_free_cap_start_only`, run `prisma migrate deploy`
  and `prisma generate`). It is stored at mint, so a plan change mid-call does not change the rule that call started under.
  For a Free call it makes `maxSeconds` the 24 hour call length limit, removes the heartbeat `cap_reached` stop and the
  billing clamp, and exempts the call from overrun flagging. Pro and Team behave as before.
- Kept on purpose: the 24 hour call length limit, the 15 minute connect window, and the clamp on a call reaped as silent
  (it is billed up to its reservation, so a closed tab is not billed for a day).
- Minutes are whole numbers and every started minute counts, so "9.5 of 10 used" is tested as 9 of 10 used.
- Text practice is not metered on any plan.

## Prices

Prices are resolved by lookup key with `stripe.prices.list({ lookup_keys })` (`resolvePriceIds` in `src/lib/billing.ts`).
The `STRIPE_PRICE_*` env vars are gone. No key, secret or price id is stored in code, tests, docs or commit messages.

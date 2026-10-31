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
- Fractional usage: `minutesUsed` and `UsageEntry.minutes` are floats (migration `20261031050000_fractional_usage_minutes`).
  Call billing is still whole minutes, every started minute counts; a half minute only comes from a support credit
  (the credit route takes 0.5 steps). A Free call starts with any minutes left, so 9.5 of 10 starts, runs 3 minutes
  uninterrupted and reads 12.5. Pro and Team still need one whole minute left to start, because the cap stops their calls.
  A Free start holds one whole minute so a second start cannot take the same last half minute.
- Text practice is not metered on any plan.
- The Free reset is the signup anchor (the existing usage anchor), not the calendar month, and the billing page copy says
  "each month on your signup date". Switching Free to calendar-month resets would change `ensureAllowance`; not done.

## Billing page and call screens

- Header copy is plan-aware (`usageHeaderCopy` in `src/lib/billingUi.ts`): Free says calls are checked only at start.
- The cap refusal, on the briefing and on the deck, shows an Upgrade link to `/settings/billing` (`CallError`). The
  message says "practice". The briefing shows "X voice minutes left" before Start, read from `/api/usage`; with none left it
  shows the refusal and Upgrade link up front and leaves Start enabled, because the server is the authority.
- Seats: the box holds raw text and clamps to 3 on blur and on submit. Checkout and portal buttons are `disabled` while
  busy, with a ref guard for same-tick double clicks and a `pageshow` reset after Back from Stripe.
- Annual mode shows $290 per user per year (Pro) and $590 per seat per year (Team), and the add-on at $300. Display
  only: Stripe prices stay the source of truth at checkout.
- A Team user sees "Included in Team" on Pro. The success banner uses `.banner-ok`. The "Test mode only" note shows
  only when `/api/usage` reports `billing.testMode` (a Stripe `sk_test_` key).

## Prices

Prices are resolved by lookup key with `stripe.prices.list({ lookup_keys })` (`resolvePriceIds` in `src/lib/billing.ts`).
The `STRIPE_PRICE_*` env vars are gone. No key, secret or price id is stored in code, tests, docs or commit messages.

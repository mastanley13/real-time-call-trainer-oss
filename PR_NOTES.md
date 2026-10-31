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
  uninterrupted and reads 12.5. Every plan starts with any minutes left, so "0.5 voice minutes left" on screen is what the
  check enforces. A start holds one whole minute (reservations are whole and round up) so a second start cannot take the
  same last half minute. A Pro or Team call is still stopped at that reserved minute and billed it, so it can end at most
  half a minute over its plan; a Free call is not stopped.
- A Free call reaped as silent is billed through its last confirmed heartbeat, plus the silent stretch after it bounded by
  the call's reservation. (It used to be clamped to the reservation as a whole, so 3 confirmed minutes could count as 1.)
  Pro and Team are unchanged: their whole call is bounded by the reservation.
- When a Team ends (cancelled or unpaid), `resolveAllowance` counts the member's pool minutes in the current Free period
  against the 10 minute cap (`Resolved.usedElsewhere`), so leaving the pool is not a fresh 10 minutes. The carry is placed
  by when each call ran, not by ledger createdAt (settlement time): a call's billed minutes are prorated by how much of
  its billed time (billing start to start plus billableSeconds) lies inside the member's personal period, because the
  organization and the member can reset on different days. A 10 minute call with 5 minutes after the member's reset counts
  5. Support credits on the pool count by their own date.
- The call timing is stored on the usage ledger, not read from `TrainerSession`: `UsageEntry.ranFrom` and `ranTo`
  (migration `20261031060000_usage_entry_call_timing`, nullable, index on `userId, ranTo`) are written with every
  `voice_call`, `voice_call_prior` and `credit_drop` entry. The retention purge deletes `TrainerSession` rows
  (`UsageEntry.trainerSessionId` is set to null, the entries stay), so carried minutes survive it. The migration backfills
  existing entries from the call rows that still exist, using the same billing start rule as `billingStart`. Entries with no
  interval (support credits, and call entries whose call row was already purged before the backfill) count at their
  `createdAt`. Run `prisma migrate deploy` and `prisma generate`. Other members, Pro members, earlier periods and calls on the
  personal allowance (already in its minutesUsed) are not counted. The usage summary shows the combined number.
- Pool members who are not an owner or manager cannot buy minutes. `/api/usage` returns `billing.canUpgrade` and the
  cap message shows "Ask your team admin for more minutes." with no Upgrade link for them (`capCopy`, `CallError`).
- vitest now compiles JSX with the automatic runtime, to match Next, so a test can call a component directly.
- Text practice is not metered on any plan.
- The Free reset is the signup anchor (the existing usage anchor), not the calendar month, and the billing page copy says
  "each month on your signup date". Switching Free to calendar-month resets would change `ensureAllowance`; not done.

## Round 7 UX fixes (Prism browser pass)

- Briefing: `MinutesLeft` shows "X of Y voice minutes left" near Start call in Voice mode when metering is on, from
  `/api/usage`, and shows it even when voice keys are missing. With none left it shows "Out of voice minutes this month."
  with an Upgrade link, or "Ask your team admin for more minutes." for a Team pool member. Text mode shows "Text practice
  is unlimited." A server refusal replaces the out-of-minutes panel instead of repeating it.
- Checkout failure: any 5xx or config error, or an answer with no checkout address, reads "Checkout is unavailable right
  now. Your plan has not changed." with a link to the GitHub issues page (no support email until billing is live). "Try
  again in a moment." is kept only for a request that got no answer (network error or timeout). A 4xx keeps the server's
  sentence. The banner stays an alert. The checkout route's 502 message is the same sentence.
- Seats: "Team starts at 3 seats." is always under the field. Leaving the box below 3 keeps the clamp and shows "Set to 3,
  the Team minimum." in an always-present status region, linked by aria-describedby while it has text.
- Pro and Team intros add "Calls are counted in whole minutes, rounded up." The Free intro only changes to "Your minutes
  reset monthly from your signup date".
- Focus rings: primary is over 3:1 against bg, surface, sunken and primary-soft in light and dark (tested from the tokens).
  Two real gaps were fixed: the hidden billing period radio now draws its ring on its chip (`has-[:focus-visible]`), and
  the seats field has an explicit 2px outline because `.input` removes the outline. The Premium Voice checkbox already
  had the global ring.
- Not done: browser screenshots and a real-browser focus walk (no browser in this environment), and `npm run build`.

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

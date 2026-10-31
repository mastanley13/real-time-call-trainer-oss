# Spec: server-controlled time limit for realtime voice calls

Status: proposed, not built. Owner: STR-715 follow-up.

**This must ship before Stripe live mode.** Today the billing clock, the cap and the reservation are all enforced on our server, but nothing on the provider side stops a call. A modified or stalled browser can keep an OpenAI Realtime or ElevenLabs session running after the server has settled the call and stopped billing the user. We would then pay the provider for minutes nobody is charged for. In test mode that is a cosmetic bug. In live mode it is real cost with no revenue. Until this is built, `stripe_live_key_refused` stays in force.

## Problem

What we have (`usage.ts`, `usagePlan.ts`):

- `beginCall` reserves minutes at mint and returns `maxSeconds` (reserved minutes, up to `MAX_RESERVE_MINUTES` = 60, never over `MAX_CALL_SECONDS`).
- The browser sends heartbeats. The server answers `stop: true` when the reservation is used up, and settles the call. The client then hangs up.
- A call with no heartbeat for `HEARTBEAT_TIMEOUT_SECONDS` (30) is reaped and settled.
- The OpenAI client secret `expires_after` limits only session setup. It does not end a running session (see the comment in `realtime/session/route.ts`).

The gap: every enforcement step ends with "the client hangs up". A client that ignores `stop`, stops heartbeating, or never calls `/api/usage/end` keeps a live provider session. The server-side settlement is correct for billing, but the provider keeps counting. `flagOverrun` records that this happened. It does not prevent it.

## Goals

1. A provider session cannot outlive its reservation by more than a small grace period, with no cooperation from the browser.
2. The limit is set by the server at mint time from the same `maxSeconds` that the ledger uses. One source of truth.
3. Where the provider cannot enforce a limit, the server ends the session itself.
4. Calls the server reaped as silent are reconciled against what the provider says happened.
5. Billing stays on the server clock. Provider data is used only to detect overruns and to close sessions, never to decide what a user is charged.

## Non-goals

- Changing plans, caps, rounding or the credit rules.
- Moving billing to provider-reported durations.
- Ending a running call because Premium share ran out. That rule stays "applies to the next session".

## Design

### 1. Set the maximum at mint

`maxSeconds` from `beginCall` is the single value. Add a grace constant in `usagePlan.ts`:

- `PROVIDER_LIMIT_GRACE_SECONDS = 20`. The provider limit is `maxSeconds + grace`, so the server's own stop (heartbeat, `max_duration`) normally fires first and the provider limit is the backstop.

Billing off (`meteringEnabled()` false): no `callId`, no `maxSeconds`. Use a fixed backstop instead (`UNMETERED_CALL_SECONDS`, default 30 minutes, env override `VOICE_MAX_CALL_SECONDS`) so a self-hosted call cannot run forever by accident. This is a safety limit, not a plan cap, and it does not write to the ledger. Document the env var in the README table.

### 2. OpenAI Realtime

Provider-side options, to verify against current docs before building (do not assume):

- **Session `max_duration` or equivalent.** If the Realtime session object (set through `client_secrets` `session`) supports a maximum session length, set it to `maxSeconds + grace` at mint. This is the preferred control because the browser cannot change it after mint. Confirm whether the client can override the session through `session.update` over the data channel. If it can, this setting alone is not trustworthy.
- **Hard session ceiling.** OpenAI documents a maximum Realtime session length (30 minutes at the time of writing). Treat it as a coarse upper bound only. It is shorter than our 60 minute reservation, so the client must already handle a provider-initiated close without losing the call row.
- **Server-controlled termination.** Mint through the unified interface so the server also holds a control channel for the call: `/v1/realtime/calls/{call_id}/hangup` ends a call from the server. This needs the server to see the call id. Today `realtime/sdp` relays the browser's SDP offer, and the answer carries the call id in a `Location` header. Record that id on the `TrainerSession` row (new nullable column `providerCallId`) when the SDP relay succeeds. Verify the endpoint and header names before building.

Server-side termination then works like this: when a settlement is written with a server reason (`cap_reached`, `max_duration`, `heartbeat_timeout`), call the provider hangup for `providerCallId`, best effort, status code only in logs. This does not depend on the browser.

If neither a provider max duration nor a hangup is available for the key in use, the durable deadline in section 2a is the only control, and live mode stays blocked until the provider facts are verified.

### 2a. Durable server deadline

Server hangup must not depend on a client request. Settlement and heartbeats only run when the browser calls us, so a silent client would never trigger them, and the 5 minute reconcile job in section 4 selects only ended calls. Add a deadline that the server enforces on its own:

- New nullable column `providerDeadlineAt` on `TrainerSession`, written at mint as `mintedAt + maxSeconds + PROVIDER_LIMIT_GRACE_SECONDS` (or `UNMETERED_CALL_SECONDS + grace` when billing is off). The database row is the schedule, so nothing lives only in process memory and a restart loses nothing.
- Route `cron/enforce-deadlines` (same `CRON_SECRET` pattern as `purge-expired`), run every minute. It selects calls with `providerDeadlineAt <= now`, no provider hangup recorded (`providerHangupAt` null) and a known provider id. For each it sends the hangup, sets `providerHangupAt`, settles the call if it is still open (reason `max_duration`, billed on the server clock as today) and calls `flagOverrun` if the provider reports extra seconds. Cap the batch and the provider calls per run.
- An in-process timer set at mint may call the same function earlier as an optimization. It is never relied on. Both paths use the same idempotent update (`providerHangupAt` null check), so a double fire sends one hangup.
- Restart recovery: on the first sweep after a restart, every overdue row is picked up by the query above. No state is rebuilt.
- Honest bound: with a trustworthy provider-side limit (section 2 or 3), the provider ends the call at `maxSeconds + grace`. Without one, the worst case is `grace + sweep interval` (about 80 seconds). State this bound in the README and do not promise 20 seconds for those providers.
- Calls with no provider id yet (SDP relay failed, or an ElevenLabs conversation not yet verified) cannot be hung up by id. They are covered by the provider limit alone and are listed in an `overrun_unresolved` audit event once past the deadline.

### 3. ElevenLabs

- **Agent-level max duration.** ElevenLabs agents have a conversation `max_duration_seconds` setting (conversation config). It is per agent, not per token. Premium and standard agents are fixed config, so this gives a ceiling equal to the longest reservation we ever grant (`MAX_RESERVE_MINUTES` plus grace), not the per-call `maxSeconds`. Set both agents to that ceiling as a deployment step and add a startup check that reads the agent config and warns when the value is missing or larger than expected. Verify the field name and that the token endpoint does not allow a client override (the conversation initiation override list must not include it).
- **Per-call limit through the server.** ElevenLabs has an API to end a conversation, and conversation signed URLs and tokens are short lived. Verify whether the token mint accepts a per-call duration. If it does, set `maxSeconds + grace` there. If not, the server ends the conversation itself: bind a conversation to the call and call the provider's end endpoint on server settlement. The client-reported `conversation_id` is a hint only. Finding it in the shared agent's conversation list proves nothing about ownership, so it is never enough to terminate anything. Binding rules:
  - The server mints a per-call nonce (the call id, or an HMAC of it) and passes it into the conversation through the signed URL or token mint, as a dynamic variable or custom metadata that the client cannot override (verify that the override list excludes it).
  - The server fetches the conversation from the provider and accepts the id only if the provider-returned metadata carries this call's nonce, the conversation started after the mint time and the agent id matches. Anything else is rejected with 409 `conversation_mismatch` and an audit event, and nothing is stored.
  - `providerConversationId` has a unique index. A reused id is rejected with 409, and a call row binds one conversation, once.
  - The bind route runs `requireAuth`, checks that the call row belongs to the caller (or the usual org rule) and rate limits per user.
  - If the provider cannot return our nonce, do not bind client-reported ids at all. The agent-level ceiling and the deadline sweep are the controls, and live mode stays blocked.
- A signed `conversation_id` that the client reports must never change what we bill. It is used only to close or inspect.

### 4. Reconciling silent and reaped calls

When a call is reaped as `heartbeat_timeout`, the server billed up to the last heartbeat plus the timeout. The provider session may still be running. A scheduled job (the existing `cron/purge-expired` pattern with `CRON_SECRET`, new route `cron/reconcile-voice`, every 5 minutes):

1. Select calls with `endReason in (heartbeat_timeout, max_duration, cap_reached)` ended within the last 24 hours and `providerReconciledAt` null (new nullable column).
2. For each, ask the provider whether the session or conversation is still active, using `providerCallId` or conversation id. If active, send the hangup, then `flagOverrun` with the provider-observed extra seconds.
3. If the provider reports a final duration that exceeds our billed seconds by more than a threshold (default 120 s, `RECONCILE_TOLERANCE_SECONDS`), write an `overrun` audit event with both numbers. Do not change the user's ledger. A systematic gap is a bug in our clock, to be fixed in code.
4. Set `providerReconciledAt` so each call is checked once. Cap the batch size and the provider calls per run so a backlog cannot stampede the provider or blow rate limits.

The job is idempotent. A second run finds nothing to do.

### 5. Client behavior

No new trust in the client. It keeps sending heartbeats and still hangs up on `stop: true` for a clean UI. Add handling for a provider-initiated close (data channel closes, or ElevenLabs disconnects) that is not preceded by a user hang up: call `end("provider_error")` only if the call was under its reservation, otherwise `end("user_hangup")`, and show "The call reached its time limit." instead of an error banner.

## Failure modes

| Failure | Expected result |
|---|---|
| Provider hangup call fails or times out | Log status code only. The reconcile job retries until `providerReconciledAt` is set or 24 hours pass, then raises an `overrun_unresolved` audit event. |
| Provider max duration is not supported for this key or agent | Mint still works. The startup check and `/settings/models` connection check show "No provider time limit. Not safe for live billing." Live mode stays refused. |
| Client overrides the session limit through the data channel | Treated as a provider limit that is not trustworthy. Server hangup is the control. Add a test that documents which provider settings the client can and cannot change. |
| Server settles a call, then the provider keeps going | Hangup on settle, reconcile job as backstop, overrun audit event with the extra seconds. |
| Provider closes early (30 minute ceiling) | Billing follows the server clock to the actual end event. The user sees the time-limit message and can start a new call. No refund, since the call ran. |
| Client goes silent and never calls settle or heartbeat | The deadline sweep (2a) sends the hangup and settles the call with no client request. Worst case `grace + sweep interval`. |
| Server restarts while calls are running | Deadlines are in the database. The next sweep ends every overdue call. |
| User A reports user B's conversation id | Bind is rejected with 409 `conversation_mismatch`. B's conversation is not ended and no row stores the id. |
| Mint succeeds but the provider id is never recorded (SDP relay fails) | Call is billed from the server mint clock as today. Only the server hangup is lost. The provider limit from section 2 or 3 is the remaining control. |
| Reconcile job cannot reach the provider | Rows stay unreconciled and are picked up on the next run. No billing change. |
| Billing off | Fixed `UNMETERED_CALL_SECONDS` provider limit only. No ledger writes, no reconcile job work. |

## Tests

All deterministic, no network, provider calls mocked.

- Mint sets the provider limit: with metering on, the OpenAI mint body contains a duration equal to `maxSeconds + PROVIDER_LIMIT_GRACE_SECONDS`. With billing off it uses `UNMETERED_CALL_SECONDS`. Same for the ElevenLabs path.
- A mint without the provider limit supported does not fail the mint but is reported by the connection check.
- Server settlement with reason `cap_reached`, `max_duration` or `heartbeat_timeout` calls the provider hangup once with the stored provider id. A user-hangup settlement does not.
- Hangup failure is logged as status only and never throws out of `endCall` or the heartbeat route.
- Reconcile job: a reaped call with an active provider session gets hung up and flagged; a call already reconciled is skipped; a call within tolerance writes no event; a call over tolerance writes one `overrun` event and leaves the ledger untouched; the batch cap is respected; a second run is a no-op.
- Deadline sweep with no client requests at all: a call past `providerDeadlineAt` gets one hangup and is settled; a call before its deadline is untouched; a second run and a concurrent in-process timer send no second hangup; a simulated restart (fresh module state, same rows) still ends the overdue call; the batch cap is respected.
- Deadline route requires `CRON_SECRET` and rejects a missing or wrong secret.
- Conversation binding: an id whose provider metadata lacks this call's nonce, or carries another call's nonce, is rejected and never hung up; an id already bound to another call is rejected with 409; a caller who does not own the call row gets 403; a matching id binds once and is used for hangup.
- Reconcile route requires `CRON_SECRET` and rejects a missing or wrong secret (copy the `purge-expired` test).
- Client-reported conversation ids never change billed seconds.
- Provider-initiated close shows the time-limit message and ends the meter once.
- `usage-reconcile.test.ts` overrun cases still pass unchanged.
- Migration: the new provider columns are nullable, and demo mode and no-database mode still work.

## Rollout

1. Verify the provider facts marked "verify" above against current documentation, and record the answers in this file.
2. Prisma migration (`providerCallId`, `providerConversationId`, `providerDeadlineAt`, `providerHangupAt`, `providerReconciledAt`), then mint-time limits, then server hangup and the deadline sweep, then the reconcile job, each behind its own PR.
3. Add the README env rows (`VOICE_MAX_CALL_SECONDS`, `RECONCILE_TOLERANCE_SECONDS`) and the TESTING.md checks.
4. Run a test-mode soak: start a call, block heartbeats, confirm the provider session ends by itself within `maxSeconds + grace`.
5. Only then relax `stripe_live_key_refused`. The live-key refusal in `stripe.ts` links back to this spec in a comment so it is not removed without it.

## Open questions

- Does the OpenAI Realtime session accept a per-session maximum duration, and can the client change it after mint?
- Is the unified `calls/{id}/hangup` flow available for our WebRTC relay without changing the browser's connection path?
- Does the ElevenLabs token endpoint take a per-call duration, or only the agent-level limit?
- What is the right `UNMETERED_CALL_SECONDS` default for self-hosters: 30 minutes, or provider ceiling only?

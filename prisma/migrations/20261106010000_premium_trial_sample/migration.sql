-- Premium voice trial call: ONE Premium call per Free organization, ever, capped at 5 minutes. Behind
-- PREMIUM_TRIAL_SAMPLE_ON=true (default off), independent of PREMIUM_VOICE_ON_SALE. Additive only: nullable columns or a
-- column with a default. Nothing is dropped, rewritten or backfilled. Separate from the paid add-on migration
-- (20261106000000_premium_voice_addon).

-- Permanent claim, written by the conditional update that mints the trial call (usage.ts beginCall). Never cleared:
-- new sessions, other members, sign-ins, retries and failed or abandoned calls do not reset it.
ALTER TABLE "Organization" ADD COLUMN "premiumTrialCallUsedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "premiumTrialCallSessionId" TEXT;

-- Marks the one call that ran as the trial: its deadline is min(existing deadline, 300 seconds).
ALTER TABLE "TrainerSession" ADD COLUMN "premiumTrial" BOOLEAN NOT NULL DEFAULT false;

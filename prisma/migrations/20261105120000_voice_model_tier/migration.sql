-- Additive only: three nullable columns, no defaults, no backfill.
-- voiceModelTier: null means Standard, "premium" means Premium (OpenAI Realtime model quality).
-- voiceModelComped: null or false means not comped. Premium is used at mint time only when comped AND tier is premium.
-- realtimeModel: which OpenAI Realtime model a session was minted with (null for text calls). Cost log only.
-- Not billing: Organization.premiumVoice and TrainerSession.engineTier (Stripe metering) are unchanged.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "voiceModelTier" TEXT,
ADD COLUMN "voiceModelComped" BOOLEAN;

-- AlterTable
ALTER TABLE "TrainerSession" ADD COLUMN "realtimeModel" TEXT;

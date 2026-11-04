-- The OpenAI Realtime call id the server opened for a voice call (so it can hang the call up), the hangup lease and
-- completion times, the one-time connect claim, and the persona stored at mint to build the provider session from.
-- Additive and nullable; no backfill. Apply to production before deploying the code that reads these columns.
ALTER TABLE "TrainerSession" ADD COLUMN "providerCallId" TEXT;
ALTER TABLE "TrainerSession" ADD COLUMN "providerHangupAt" TIMESTAMP(3);
ALTER TABLE "TrainerSession" ADD COLUMN "providerHangupLeaseAt" TIMESTAMP(3);
ALTER TABLE "TrainerSession" ADD COLUMN "providerConnectClaimAt" TIMESTAMP(3);
ALTER TABLE "TrainerSession" ADD COLUMN "providerSession" JSONB;
CREATE UNIQUE INDEX "TrainerSession_providerCallId_key" ON "TrainerSession"("providerCallId");

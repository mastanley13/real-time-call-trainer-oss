-- Premium minutes are reserved per call, like total minutes.
ALTER TABLE "UsageAllowance" ADD COLUMN     "premiumMinutesReserved" INTEGER NOT NULL DEFAULT 0;

-- Per-call premium reservation, the share held in the next period after a rollover, and the overrun flag.
ALTER TABLE "TrainerSession" ADD COLUMN     "premiumReservedMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "carriedMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "carriedPremiumMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "abuseFlagged" BOOLEAN NOT NULL DEFAULT false;

-- A user whose call ran past its reservation cannot mint a new voice call until this time.
ALTER TABLE "User" ADD COLUMN     "voiceBlockedUntil" TIMESTAMP(3);

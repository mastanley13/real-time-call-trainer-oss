-- Premium Voice add-on: flat 40 Premium minutes per unit from the plan pool, add-on quantity, period end and
-- scheduled changes. Additive only: new nullable columns or columns with defaults. Nothing is dropped or rewritten.

ALTER TABLE "Organization" ADD COLUMN "premiumVoiceQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "subscriptionPeriodEnd" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "premiumVoiceRemoveAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "seatCountAtRenewal" INTEGER;

ALTER TABLE "User" ADD COLUMN "premiumVoiceQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "subscriptionPeriodEnd" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "premiumVoiceRemoveAt" TIMESTAMP(3);

ALTER TABLE "UsageAllowance" ADD COLUMN "premiumMinutesCap" INTEGER NOT NULL DEFAULT 0;

-- Premium Voice add-on: flat 40 Premium minutes per unit from the plan pool, add-on quantity, period end and
-- scheduled changes. Additive only: new nullable columns or columns with defaults. Nothing is dropped or rewritten.

ALTER TABLE "Organization" ADD COLUMN "premiumVoiceQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "subscriptionPeriodEnd" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "premiumVoiceRemoveAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "seatCountAtRenewal" INTEGER;

ALTER TABLE "User" ADD COLUMN "premiumVoiceQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "subscriptionPeriodEnd" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "premiumVoiceRemoveAt" TIMESTAMP(3);

-- Premium suspended by a failed payment (invoice.payment_failed). Cleared only when that invoice is paid
-- (invoice.paid, verified against the subscription as Stripe has it). An unrelated subscription update never clears it.
ALTER TABLE "Organization" ADD COLUMN "premiumSuspendedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "premiumSuspendedInvoiceId" TEXT;
ALTER TABLE "User" ADD COLUMN "premiumSuspendedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "premiumSuspendedInvoiceId" TEXT;

ALTER TABLE "UsageAllowance" ADD COLUMN "premiumMinutesCap" INTEGER NOT NULL DEFAULT 0;

-- Effective voice tier a call was minted on ("premium" or "standard"), written by the server at mint. Separate from
-- engineTier, which stays the billing engine (a comped call is billed on standard but runs Premium).
ALTER TABLE "TrainerSession" ADD COLUMN "voiceTier" TEXT;

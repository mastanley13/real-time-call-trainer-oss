-- Reservations and premium accounting on the allowance.
ALTER TABLE "UsageAllowance" ADD COLUMN     "minutesReserved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "premiumMinutesUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- A call is bound to the allowance and period it was minted against.
ALTER TABLE "TrainerSession" ADD COLUMN     "allowanceId" TEXT,
ADD COLUMN     "allowancePeriodStart" TIMESTAMP(3),
ADD COLUMN     "reservedMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "engineTier" TEXT NOT NULL DEFAULT 'standard';

-- One outstanding Checkout Session per billing subject.
ALTER TABLE "Organization" ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "stripeCheckoutFingerprint" TEXT,
ADD COLUMN     "stripeCheckoutUrl" TEXT,
ADD COLUMN     "stripeCheckoutExpiresAt" TIMESTAMP(3);

ALTER TABLE "User" ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "stripeCheckoutFingerprint" TEXT,
ADD COLUMN     "stripeCheckoutUrl" TEXT,
ADD COLUMN     "stripeCheckoutExpiresAt" TIMESTAMP(3);

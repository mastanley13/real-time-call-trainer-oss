-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('voice_call', 'credit_drop', 'credit_manual');

-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('user_hangup', 'network_drop', 'provider_error', 'server_error', 'cap_reached', 'max_duration', 'heartbeat_timeout', 'failed_connect');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "premiumVoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seatCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planTier" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "premiumVoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" TEXT,
ADD COLUMN     "usageAnchorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "TrainerSession" ADD COLUMN     "billableSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "billedMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "connectedAt" TIMESTAMP(3),
ADD COLUMN     "degradedAt" TIMESTAMP(3),
ADD COLUMN     "endReason" "CallEndReason",
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UsageAllowance" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "planTier" TEXT NOT NULL,
    "minutesCap" INTEGER NOT NULL,
    "anchorAt" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "minutesUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allowanceId" TEXT NOT NULL,
    "trainerSessionId" TEXT,
    "kind" "UsageKind" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageAllowance_userId_key" ON "UsageAllowance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAllowance_organizationId_key" ON "UsageAllowance"("organizationId");

-- CreateIndex
CREATE INDEX "UsageEntry_allowanceId_createdAt_idx" ON "UsageEntry"("allowanceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEntry_userId_idx" ON "UsageEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEntry_trainerSessionId_kind_key" ON "UsageEntry"("trainerSessionId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeCustomerId_key" ON "Organization"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_stripeSubscriptionId_key" ON "Organization"("stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "UsageAllowance" ADD CONSTRAINT "UsageAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageAllowance" ADD CONSTRAINT "UsageAllowance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEntry" ADD CONSTRAINT "UsageEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEntry" ADD CONSTRAINT "UsageEntry_trainerSessionId_fkey" FOREIGN KEY ("trainerSessionId") REFERENCES "TrainerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing accounts anchor their monthly reset to signup, not to the day this migration ran.
UPDATE "User" SET "usageAnchorAt" = "createdAt";

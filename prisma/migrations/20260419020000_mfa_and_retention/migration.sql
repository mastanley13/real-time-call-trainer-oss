-- AlterTable: Organization retention
ALTER TABLE "Organization"
  ADD COLUMN "sessionRetentionDays" INTEGER;

-- AlterTable: User MFA state
ALTER TABLE "User"
  ADD COLUMN "mfaSecret" TEXT,
  ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);

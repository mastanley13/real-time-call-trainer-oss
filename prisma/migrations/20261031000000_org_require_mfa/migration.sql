-- AlterTable: Organization MFA enforcement (Team plan). Inert until a manager turns it on.
ALTER TABLE "Organization"
  ADD COLUMN "requireMfa" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfaGraceEndsAt" TIMESTAMP(3);

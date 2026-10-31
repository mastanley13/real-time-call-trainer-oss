-- Solo sign-up: a personal organization holds one person on the Free tier.

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "isPersonal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TrainerSession"
  ADD COLUMN "supervisorNotes" TEXT,
  ADD COLUMN "supervisorNotesBy" TEXT,
  ADD COLUMN "supervisorNotesAt" TIMESTAMP(3);

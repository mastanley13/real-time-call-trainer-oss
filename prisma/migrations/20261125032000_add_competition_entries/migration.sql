ALTER TABLE "TrainerSession" ADD COLUMN IF NOT EXISTS "isCompetition" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS "CompetitionEntry" (
  "id" TEXT PRIMARY KEY,
  "seasonSlug" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trainerSessionId" TEXT,
  "trackSlug" TEXT NOT NULL,
  "scenarioId" TEXT NOT NULL,
  "attemptNumber" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'minted',
  "displayName" TEXT NOT NULL,
  "teamLabel" TEXT,
  "overallScore" INTEGER,
  "grade" TEXT,
  "goalAchieved" BOOLEAN,
  "durationSeconds" INTEGER NOT NULL DEFAULT 0,
  "shareToken" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "CompetitionEntry_trainerSessionId_key" ON "CompetitionEntry" ("trainerSessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "CompetitionEntry_shareToken_key" ON "CompetitionEntry" ("shareToken");
CREATE UNIQUE INDEX IF NOT EXISTS "CompetitionEntry_seasonSlug_userId_attemptNumber_key" ON "CompetitionEntry" ("seasonSlug", "userId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "CompetitionEntry_seasonSlug_status_overallScore_completedAt_idx" ON "CompetitionEntry" ("seasonSlug", "status", "overallScore", "completedAt");
CREATE INDEX IF NOT EXISTS "CompetitionEntry_seasonSlug_trackSlug_status_overallScore_c_idx" ON "CompetitionEntry" ("seasonSlug", "trackSlug", "status", "overallScore", "completedAt");
CREATE INDEX IF NOT EXISTS "CompetitionEntry_seasonSlug_userId_idx" ON "CompetitionEntry" ("seasonSlug", "userId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CompetitionEntry_userId_fkey' AND conrelid = '"CompetitionEntry"'::regclass) THEN
    ALTER TABLE "CompetitionEntry" ADD CONSTRAINT "CompetitionEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CompetitionEntry_trainerSessionId_fkey' AND conrelid = '"CompetitionEntry"'::regclass) THEN
    ALTER TABLE "CompetitionEntry" ADD CONSTRAINT "CompetitionEntry_trainerSessionId_fkey" FOREIGN KEY ("trainerSessionId") REFERENCES "TrainerSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Durable call timing on the usage ledger. Which month a call's minutes belong to must not depend on the
-- TrainerSession row, which the retention purge deletes. Both columns are nullable: support credits have no call.
ALTER TABLE "UsageEntry" ADD COLUMN     "ranFrom" TIMESTAMP(3),
ADD COLUMN     "ranTo" TIMESTAMP(3);

-- Backfill from the call rows that still exist. Billing start is the client's connected time, never later than the
-- mint time plus 60 seconds (MAX_CONNECT_LAG_SECONDS in usagePlan.ts); the end is the start plus billable seconds.
-- LEAST ignores NULL, so a call that never reported connected starts at the 60 second cutoff.
UPDATE "UsageEntry" AS e
SET "ranFrom" = s."start",
    "ranTo" = s."start" + (s."billableSeconds" * INTERVAL '1 second')
FROM (
  SELECT "id",
         COALESCE(LEAST("connectedAt", "createdAt" + INTERVAL '60 seconds'), "createdAt" + INTERVAL '60 seconds') AS "start",
         "billableSeconds"
  FROM "TrainerSession"
) AS s
WHERE e."trainerSessionId" = s."id"
  AND e."kind" IN ('voice_call', 'voice_call_prior', 'credit_drop')
  AND s."billableSeconds" > 0;

CREATE INDEX "UsageEntry_userId_ranTo_idx" ON "UsageEntry"("userId", "ranTo");

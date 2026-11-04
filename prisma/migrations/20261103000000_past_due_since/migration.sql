-- When a subscription first entered past_due. The grace window for paid access counts from here; null in any other status.
ALTER TABLE "User" ADD COLUMN "pastDueSince" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "pastDueSince" TIMESTAMP(3);

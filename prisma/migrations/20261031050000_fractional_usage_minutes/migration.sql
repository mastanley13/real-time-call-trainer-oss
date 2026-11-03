-- Usage can be a half minute (a support credit of 0.5), so a Free account can sit at 9.5 of 10 and still start a call.
-- Call billing is unchanged: every started minute counts as a whole minute. Existing whole values convert exactly.
ALTER TABLE "UsageAllowance" ALTER COLUMN "minutesUsed" SET DATA TYPE DOUBLE PRECISION;
ALTER TABLE "UsageEntry" ALTER COLUMN "minutes" SET DATA TYPE DOUBLE PRECISION;

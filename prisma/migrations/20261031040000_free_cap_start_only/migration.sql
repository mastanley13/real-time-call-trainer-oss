-- Free voice minutes are checked only when a call starts. The rule a call was started under is stored on it,
-- so a plan change mid-call does not change how that call is stopped or billed. Existing calls keep the old rule.
ALTER TABLE "TrainerSession" ADD COLUMN     "capEnforced" BOOLEAN NOT NULL DEFAULT true;

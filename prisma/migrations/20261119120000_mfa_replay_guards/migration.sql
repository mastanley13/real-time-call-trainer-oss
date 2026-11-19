-- MFA replay guards: each challenge JWT is single-use (consumed jti until the
-- token expires), and a TOTP time-step cannot be reused for the same user.
ALTER TABLE "User" ADD COLUMN "mfaLastTotpStep" INTEGER;

CREATE TABLE "ConsumedMfaChallenge" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumedMfaChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsumedMfaChallenge_expiresAt_idx" ON "ConsumedMfaChallenge"("expiresAt");

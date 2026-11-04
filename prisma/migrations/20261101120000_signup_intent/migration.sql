-- What the sign-up link asked for. Nullable, set once at account creation from whitelisted values.
ALTER TABLE "User" ADD COLUMN     "signupPlanIntent" TEXT,
ADD COLUMN     "signupInterval" TEXT,
ADD COLUMN     "signupSrc" TEXT,
ADD COLUMN     "signupSeg" TEXT;

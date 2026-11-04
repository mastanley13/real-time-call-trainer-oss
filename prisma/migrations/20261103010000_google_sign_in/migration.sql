-- Google sign-in. Accounts created through Google have no password, and keep the Google subject id so the
-- same Google account always resolves to the same user.
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inviteCodeId" TEXT;

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "minuteQuota" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_codeHash_key" ON "InviteCode"("codeHash");

-- CreateIndex
CREATE INDEX "InviteCode_createdAt_idx" ON "InviteCode"("createdAt");

-- CreateIndex
CREATE INDEX "User_inviteCodeId_idx" ON "User"("inviteCodeId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_inviteCodeId_fkey" FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


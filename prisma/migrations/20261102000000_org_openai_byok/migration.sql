-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "openaiKeyCiphertext" TEXT,
ADD COLUMN     "openaiKeyLast4" TEXT,
ADD COLUMN     "openaiKeyUpdatedAt" TIMESTAMP(3);

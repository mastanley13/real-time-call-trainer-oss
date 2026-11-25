-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomScenario" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sharedWithOrg" BOOLEAN NOT NULL DEFAULT false,
    "keepRealNames" BOOLEAN NOT NULL DEFAULT true,
    "sourceUrl" TEXT,
    "title" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "callType" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomScenario_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomScenario_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CustomScenario_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CustomScenario_userId_updatedAt_idx" ON "CustomScenario"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "CustomScenario_organizationId_sharedWithOrg_idx" ON "CustomScenario"("organizationId", "sharedWithOrg");

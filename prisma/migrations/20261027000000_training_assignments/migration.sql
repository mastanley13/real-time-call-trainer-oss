-- CreateTable
CREATE TABLE "TrainingAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "scenarioId" TEXT NOT NULL,
    "scenarioTitle" TEXT NOT NULL,
    "note" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingAssignment_organizationId_archivedAt_idx" ON "TrainingAssignment"("organizationId", "archivedAt");

-- CreateIndex
CREATE INDEX "TrainingAssignment_assigneeId_idx" ON "TrainingAssignment"("assigneeId");

-- CreateIndex
CREATE INDEX "TrainingAssignment_assignedById_idx" ON "TrainingAssignment"("assignedById");

-- AddForeignKey
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


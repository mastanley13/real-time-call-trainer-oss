-- CreateTable
CREATE TABLE "GhlOutbox" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "GhlOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GhlOutbox_idempotencyKey_key" ON "GhlOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GhlOutbox_status_nextAttemptAt_idx" ON "GhlOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GhlOutbox_userId_event_idx" ON "GhlOutbox"("userId", "event");

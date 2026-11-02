-- One-row durable state for the OpenAI spend monitor and the runtime kill switch (STR-691).
CREATE TABLE "SpendState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "tripped" BOOLEAN NOT NULL DEFAULT false,
    "trippedAt" TIMESTAMP(3),
    "tripReason" TEXT,
    "dailyCapDay" TEXT,
    "budgetPeriod" TEXT,
    "alertedThresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "periodCostUsd" DOUBLE PRECISION,
    "todayCostUsd" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendState_pkey" PRIMARY KEY ("id")
);

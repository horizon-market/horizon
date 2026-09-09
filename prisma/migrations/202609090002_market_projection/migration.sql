-- CreateTable
CREATE TABLE "MarketProjection" (
    "address" TEXT NOT NULL,
    "creationId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "rules" TEXT NOT NULL,
    "evidenceSource" TEXT NOT NULL,
    "closeAt" TIMESTAMP(3) NOT NULL,
    "resolver" TEXT NOT NULL,
    "yesToken" TEXT NOT NULL,
    "noToken" TEXT NOT NULL,
    "result" INTEGER NOT NULL DEFAULT 0,
    "resolutionEvidence" TEXT NOT NULL,
    "collateral" TEXT NOT NULL DEFAULT '0',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "indexedBlock" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketProjection_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "CurveProjection" (
    "id" TEXT NOT NULL,
    "marketAddress" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "flags" INTEGER NOT NULL,
    "startPrice" INTEGER NOT NULL,
    "endPrice" INTEGER NOT NULL,
    "maxShares" TEXT NOT NULL,
    "filled" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "indexedBlock" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurveProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncCheckpoint" (
    "id" TEXT NOT NULL,
    "indexedBlock" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OK',
    "failureCode" TEXT,
    "markets" INTEGER NOT NULL DEFAULT 0,
    "curves" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketProjection_createdAt_idx" ON "MarketProjection"("createdAt");

-- CreateIndex
CREATE INDEX "MarketProjection_result_closeAt_idx" ON "MarketProjection"("result", "closeAt");

-- CreateIndex
CREATE INDEX "CurveProjection_maker_publishedAt_idx" ON "CurveProjection"("maker", "publishedAt");

-- CreateIndex
CREATE INDEX "CurveProjection_marketAddress_active_idx" ON "CurveProjection"("marketAddress", "active");

-- AddForeignKey
ALTER TABLE "CurveProjection" ADD CONSTRAINT "CurveProjection_marketAddress_fkey" FOREIGN KEY ("marketAddress") REFERENCES "MarketProjection"("address") ON DELETE CASCADE ON UPDATE CASCADE;

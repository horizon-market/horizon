-- Live layer: what the Substreams consumer records between sync sweeps, the SSE replay log,
-- creator notifications, and the registry key each creation request deploys under.
--
-- Backward compatibility: MarketProjection, CurveProjection and SyncCheckpoint are untouched and
-- stay owned by the sync sweep. `creationId` is nullable; existing requests are matched by their
-- marketAddress until `scripts/creation-id-backfill.ts` fills the column, and every request that
-- starts creating from now on writes it before anything is broadcast.

-- AlterTable
ALTER TABLE "CreationChild" ADD COLUMN     "creationId" TEXT;

-- AlterTable
ALTER TABLE "CreationRequest" ADD COLUMN     "creationId" TEXT;

-- CreateTable
CREATE TABLE "StreamCheckpoint" (
    "id" TEXT NOT NULL,
    "cursor" TEXT NOT NULL DEFAULT '',
    "blockNumber" INTEGER NOT NULL DEFAULT 0,
    "blockHash" TEXT NOT NULL DEFAULT '',
    "finalBlock" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveChange" (
    "id" BIGSERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "maker" TEXT,
    "payload" JSONB NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "isYes" BOOLEAN NOT NULL,
    "isBuy" BOOLEAN NOT NULL,
    "shares" TEXT NOT NULL,
    "usdc" TEXT NOT NULL,
    "fills" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "revertedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'stream',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "position" INTEGER,
    "marketAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "href" TEXT NOT NULL,
    "blockNumber" INTEGER,
    "txHash" TEXT,
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveEvent" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "blockNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveChange_entity_key_blockNumber_idx" ON "LiveChange"("entity", "key", "blockNumber");

-- CreateIndex
CREATE INDEX "LiveChange_market_blockNumber_idx" ON "LiveChange"("market", "blockNumber");

-- CreateIndex
CREATE INDEX "LiveChange_maker_blockNumber_idx" ON "LiveChange"("maker", "blockNumber");

-- CreateIndex
CREATE INDEX "LiveChange_blockNumber_idx" ON "LiveChange"("blockNumber");

-- CreateIndex
CREATE INDEX "LiveChange_retiredAt_idx" ON "LiveChange"("retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LiveChange_txHash_logIndex_entity_key_key" ON "LiveChange"("txHash", "logIndex", "entity", "key");

-- CreateIndex
CREATE INDEX "Trade_market_blockNumber_idx" ON "Trade"("market", "blockNumber");

-- CreateIndex
CREATE INDEX "Trade_blockNumber_idx" ON "Trade"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_requestId_createdAt_idx" ON "Notification"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_marketAddress_idx" ON "Notification"("marketAddress");

-- CreateIndex
CREATE INDEX "LiveEvent_createdAt_idx" ON "LiveEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CreationChild_creationId_idx" ON "CreationChild"("creationId");

-- CreateIndex
CREATE INDEX "CreationRequest_creationId_idx" ON "CreationRequest"("creationId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;


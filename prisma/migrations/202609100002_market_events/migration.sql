-- Events, their children, and per-child creation state.
--
-- Backward compatibility: every existing CreationRequest is a standalone, single-market
-- request. `kind` defaults to 'SINGLE' and `eventId` stays NULL, so existing rows keep
-- their exact previous behaviour and every existing market URL keeps working. Markets
-- that belong to no EventMarket row are standalone and are listed exactly as before.

-- CreateTable
CREATE TABLE "MarketEvent" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "tags" JSONB,
    "imageUrl" TEXT,
    "iconUrl" TEXT,
    "exclusivity" TEXT NOT NULL DEFAULT 'COLLECTION',
    "exclusivityNote" TEXT NOT NULL DEFAULT '',
    "outcomesComplete" BOOLEAN NOT NULL DEFAULT false,
    "sourceProvider" TEXT NOT NULL DEFAULT 'horizon',
    "sourceEventId" TEXT,
    "sourceSlug" TEXT,
    "sourceUrl" TEXT,
    "importedAt" TIMESTAMP(3),
    "sourceSnapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMarket" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "marketAddress" TEXT,
    "sourceMarketId" TEXT,
    "sourceSlug" TEXT,
    "sourceUrl" TEXT,
    "sourceSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventMarket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreationChild" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draftHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "marketAddress" TEXT,
    "creationTxHash" TEXT,
    "failureCode" TEXT,
    "failureDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreationChild_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CreationRequest" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "eventId" UUID;

-- AlterTable
ALTER TABLE "MarketResolution" ADD COLUMN     "eventId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "MarketEvent_slug_key" ON "MarketEvent"("slug");

-- One Horizon event per source event: this is what makes a concurrent or retried import
-- idempotent rather than racing two events into existence for the same source.
CREATE UNIQUE INDEX "MarketEvent_sourceProvider_sourceEventId_key" ON "MarketEvent"("sourceProvider", "sourceEventId");

-- CreateIndex
CREATE INDEX "MarketEvent_status_createdAt_idx" ON "MarketEvent"("status", "createdAt");

-- A market belongs to at most one event, so browsing never renders a duplicate card.
CREATE UNIQUE INDEX "EventMarket_marketAddress_key" ON "EventMarket"("marketAddress");

-- CreateIndex
CREATE INDEX "EventMarket_marketAddress_idx" ON "EventMarket"("marketAddress");

-- CreateIndex
CREATE UNIQUE INDEX "EventMarket_eventId_position_key" ON "EventMarket"("eventId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "EventMarket_eventId_sourceMarketId_key" ON "EventMarket"("eventId", "sourceMarketId");

-- CreateIndex
CREATE INDEX "CreationChild_status_idx" ON "CreationChild"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CreationChild_requestId_position_key" ON "CreationChild"("requestId", "position");

-- CreateIndex
CREATE INDEX "CreationRequest_eventId_idx" ON "CreationRequest"("eventId");

-- CreateIndex
CREATE INDEX "MarketResolution_eventId_result_idx" ON "MarketResolution"("eventId", "result");

-- AddForeignKey
ALTER TABLE "CreationRequest" ADD CONSTRAINT "CreationRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MarketEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMarket" ADD CONSTRAINT "EventMarket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MarketEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreationChild" ADD CONSTRAINT "CreationChild_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

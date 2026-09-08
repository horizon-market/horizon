-- AlterTable
ALTER TABLE "CreationRequest" ADD COLUMN     "accessTokenHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedHash" TEXT,
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creationTxHash" TEXT,
ADD COLUMN     "discountBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discountNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "draft" JSONB,
ADD COLUMN     "draftHash" TEXT,
ADD COLUMN     "draftMode" TEXT,
ADD COLUMN     "draftProvider" TEXT,
ADD COLUMN     "duplicates" JSONB,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureDetail" TEXT,
ADD COLUMN     "marketAddress" TEXT,
ADD COLUMN     "priceUnits" TEXT NOT NULL DEFAULT '0',
ADD COLUMN     "requester" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUIRED',
    "scheme" TEXT NOT NULL DEFAULT 'exact',
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountUnits" TEXT NOT NULL,
    "payTo" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "facilitator" TEXT NOT NULL,
    "payloadHash" TEXT,
    "transactionRef" TEXT,
    "payer" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanVerification" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "nullifierHash" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountUsage" (
    "id" UUID NOT NULL,
    "nullifierHash" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscountUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketResolution" (
    "id" UUID NOT NULL,
    "market" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "failureCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_requestId_key" ON "PaymentIntent"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_nonce_key" ON "PaymentIntent"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_payloadHash_key" ON "PaymentIntent"("payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_transactionRef_key" ON "PaymentIntent"("transactionRef");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HumanVerification_requestId_key" ON "HumanVerification"("requestId");

-- CreateIndex
CREATE INDEX "HumanVerification_nullifierHash_idx" ON "HumanVerification"("nullifierHash");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountUsage_nullifierHash_day_key" ON "DiscountUsage"("nullifierHash", "day");

-- CreateIndex
CREATE UNIQUE INDEX "MarketResolution_market_key" ON "MarketResolution"("market");

-- CreateIndex
CREATE INDEX "AdminAudit_createdAt_idx" ON "AdminAudit"("createdAt");

-- CreateIndex
CREATE INDEX "CreationRequest_status_createdAt_idx" ON "CreationRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanVerification" ADD CONSTRAINT "HumanVerification_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

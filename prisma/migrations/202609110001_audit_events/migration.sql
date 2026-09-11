-- Durable outbox for the public Hedera Consensus Service audit trail.
--
-- Additive and backward compatible: no existing table or column changes, and a request with no
-- rows here behaves exactly as it did before. Rows are written in the same transaction as the
-- workflow transition they record, and published asynchronously, so an unreachable topic can
-- never repeat a payment, repeat a deployment or fail a creation.

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "network" TEXT,
    "topicId" TEXT,
    "transactionId" TEXT,
    "consensusAt" TIMESTAMP(3),
    "sequenceNumber" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_eventId_key" ON "AuditEvent"("eventId");

-- CreateIndex
CREATE INDEX "AuditEvent_status_nextAttemptAt_idx" ON "AuditEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_sequence_idx" ON "AuditEvent"("requestId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_requestId_sequence_key" ON "AuditEvent"("requestId", "sequence");

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CreationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

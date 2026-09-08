CREATE TABLE "CreationRequest" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "requesterKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreationRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreationRequest_idempotencyKey_key" ON "CreationRequest"("idempotencyKey");

CREATE TABLE "JobRun" (
    "id" UUID NOT NULL,
    "queueJobId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- Managed by connect-pg-simple, deliberately excluded from AdminJS resources.
CREATE TABLE "AdminSession" (
    "sid" VARCHAR NOT NULL PRIMARY KEY,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX "AdminSession_expire_idx" ON "AdminSession" ("expire");

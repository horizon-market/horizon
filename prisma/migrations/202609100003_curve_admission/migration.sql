-- An indexed curve is executable only once the Horizon router has admitted it, which is where its
-- per-market order budget was checked. Shipping straight to Aqua leaves `admitted` false, and the
-- mirror keeps such an order visible to its maker without ever serving it as market depth.
ALTER TABLE "CurveProjection" ADD COLUMN "admitted" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS "CurveProjection_marketAddress_active_idx";
CREATE INDEX "CurveProjection_marketAddress_active_admitted_idx"
  ON "CurveProjection"("marketAddress", "active", "admitted");

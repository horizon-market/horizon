-- A requester lists their own creation requests in the portfolio, newest first.
CREATE INDEX "CreationRequest_requester_createdAt_idx" ON "CreationRequest"("requester", "createdAt");

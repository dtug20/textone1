CREATE TABLE "RealtimeSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nextAllowedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chunks" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RealtimeSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RealtimeSession_orgId_expiresAt_idx" ON "RealtimeSession"("orgId", "expiresAt");
CREATE UNIQUE INDEX "RealtimeSession_orgId_key" ON "RealtimeSession"("orgId");

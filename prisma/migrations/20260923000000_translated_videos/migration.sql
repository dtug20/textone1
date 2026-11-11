CREATE TABLE "TranslatedVideo" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TranslatedVideo_sessionId_key" ON "TranslatedVideo"("sessionId");
CREATE INDEX "TranslatedVideo_orgId_createdAt_idx" ON "TranslatedVideo"("orgId", "createdAt");
CREATE TABLE "TranslatedVideoSegment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "videoId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "sourceStart" DOUBLE PRECISION NOT NULL,
  "duration" DOUBLE PRECISION NOT NULL,
  "text" TEXT NOT NULL,
  "translation" TEXT NOT NULL,
  "videoKey" TEXT NOT NULL,
  "audioKey" TEXT,
  CONSTRAINT "TranslatedVideoSegment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "TranslatedVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TranslatedVideoSegment_videoId_sequence_key" ON "TranslatedVideoSegment"("videoId", "sequence");

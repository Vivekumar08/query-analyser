-- AlterTable
ALTER TABLE "App" ADD COLUMN     "thresholdMs" INTEGER;

-- AlterTable
ALTER TABLE "QueryDailyRollup" ADD COLUMN     "errors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "histFine" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "minSampleRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QueryRollup" ADD COLUMN     "errors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "histFine" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "minSampleRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QuerySignature" ADD COLUMN     "database" TEXT,
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "orm" TEXT,
ADD COLUMN     "sqlText" TEXT;

-- CreateTable
CREATE TABLE "QuotaDrop" (
    "appId" TEXT NOT NULL,
    "bucketHour" TIMESTAMPTZ(3) NOT NULL,
    "droppedNew" INTEGER NOT NULL,

    CONSTRAINT "QuotaDrop_pkey" PRIMARY KEY ("appId","bucketHour")
);

-- AddForeignKey
ALTER TABLE "QuotaDrop" ADD CONSTRAINT "QuotaDrop_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot declare a nullable scalar list, so "no fine histogram" is the
-- empty array (Mongo rollups). Hand-written CHECK: empty or exactly 14 buckets
-- (FINE_HIST_SIZE). Added NOT VALID then VALIDATEd so the ADD takes only a brief
-- lock and the scan runs under SHARE UPDATE EXCLUSIVE (writes keep flowing).
-- cardinality(NULL) is NULL, which a CHECK accepts.
ALTER TABLE "QueryRollup" ADD CONSTRAINT "QueryRollup_histFine_length_check" CHECK (cardinality("histFine") IN (0, 14)) NOT VALID;
ALTER TABLE "QueryRollup" VALIDATE CONSTRAINT "QueryRollup_histFine_length_check";
ALTER TABLE "QueryDailyRollup" ADD CONSTRAINT "QueryDailyRollup_histFine_length_check" CHECK (cardinality("histFine") IN (0, 14)) NOT VALID;
ALTER TABLE "QueryDailyRollup" VALIDATE CONSTRAINT "QueryDailyRollup_histFine_length_check";

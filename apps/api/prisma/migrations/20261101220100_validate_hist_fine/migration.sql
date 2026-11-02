-- Kept in its own migration file on purpose. Prisma wraps each file in one
-- transaction, so with nothing else in the file this transaction holds only
-- SHARE UPDATE EXCLUSIVE while it scans, and ingest writes keep flowing.
-- (Validating in the same file as the ADD COLUMN would hold ACCESS EXCLUSIVE.)
ALTER TABLE "QueryRollup" VALIDATE CONSTRAINT "QueryRollup_histFine_length_check";
ALTER TABLE "QueryDailyRollup" VALIDATE CONSTRAINT "QueryDailyRollup_histFine_length_check";

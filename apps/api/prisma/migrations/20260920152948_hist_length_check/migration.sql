-- Prisma's schema language cannot express a CHECK constraint, so this is
-- hand-written. Guarantees at the database level that `hist` always has
-- exactly 8 elements (one per HIST_BOUNDS bucket), matching the contract's
-- `ingestItemSchema` (`hist: z.array(...).length(HIST_SIZE)`), regardless of
-- what path writes the row.
ALTER TABLE "QueryRollup" ADD CONSTRAINT "QueryRollup_hist_length_check" CHECK (array_length("hist", 1) = 8);
ALTER TABLE "QueryDailyRollup" ADD CONSTRAINT "QueryDailyRollup_hist_length_check" CHECK (array_length("hist", 1) = 8);

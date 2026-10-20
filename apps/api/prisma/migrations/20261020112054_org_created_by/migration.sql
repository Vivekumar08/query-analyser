-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "createdById" TEXT;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: an org's creator is its earliest OWNER membership (ties broken by
-- id). Only NULLs are filled, so re-running changes nothing, and an empty
-- table is a no-op. Orgs whose creator has since left are attributed to the
-- earliest remaining owner; orgs with no owner stay NULL.
UPDATE "Organization" o
SET "createdById" = first_owner."userId"
FROM (
  SELECT DISTINCT ON (m."orgId") m."orgId", m."userId"
  FROM "Membership" m
  WHERE m.role = 'OWNER'::"Role"
  ORDER BY m."orgId", m."createdAt", m.id
) AS first_owner
WHERE o.id = first_owner."orgId" AND o."createdById" IS NULL;

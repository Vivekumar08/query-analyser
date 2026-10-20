-- AlterTable
ALTER TABLE "Invite" ADD COLUMN     "appId" TEXT;

-- CreateTable
CREATE TABLE "AppAccess" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppAccess_userId_idx" ON "AppAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AppAccess_appId_userId_key" ON "AppAccess"("appId", "userId");

-- CreateIndex
CREATE INDEX "Invite_appId_idx" ON "Invite"("appId");

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAccess" ADD CONSTRAINT "AppAccess_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAccess" ADD CONSTRAINT "AppAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma can't express a CHECK constraint. Per-app roles are MEMBER or VIEWER;
-- OWNER and ADMIN are org-wide and never have AppAccess rows.
ALTER TABLE "AppAccess" ADD CONSTRAINT "AppAccess_role_check" CHECK (role IN ('MEMBER'::"Role", 'VIEWER'::"Role"));

-- backfill:start
-- Nobody loses access on deploy: every MEMBER/VIEWER keeps every app their
-- org has today, with their membership role. Idempotent (ON CONFLICT) and a
-- no-op on an empty database.
INSERT INTO "AppAccess" ("id", "appId", "userId", "role", "createdAt")
SELECT gen_random_uuid()::text, a."id", m."userId", m."role", now()
FROM "Membership" m
JOIN "App" a ON a."orgId" = m."orgId"
WHERE m."role" IN ('MEMBER'::"Role", 'VIEWER'::"Role")
ON CONFLICT ("appId", "userId") DO NOTHING;
-- backfill:end

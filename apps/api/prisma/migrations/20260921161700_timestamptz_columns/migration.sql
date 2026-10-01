-- On a database that holds real (non-test) data, this conversion from
-- timestamp WITHOUT time zone to timestamptz must not be allowed to run
-- under an ambient session timezone: PostgreSQL interprets the existing
-- naive values as being in the session's timezone when converting them
-- to timestamptz. Either `SET timezone = 'UTC'` before running this
-- migration, or (as done below) use an explicit
-- `USING "<col>" AT TIME ZONE 'UTC'` clause so the conversion is correct
-- regardless of the session's timezone setting. This local database holds
-- only test data, so the explicit USING clause below is a safety net
-- rather than a strict necessity here.

-- AlterTable
ALTER TABLE "Advice" ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Alert" ALTER COLUMN "detectedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "detectedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "acknowledgedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "acknowledgedAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "App" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "IngestKey" ALTER COLUMN "lastUsedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "lastUsedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "revokedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "revokedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Invite" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
ALTER COLUMN "acceptedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "acceptedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Membership" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "Organization" ALTER COLUMN "suspendedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "suspendedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "QueryDailyRollup" ALTER COLUMN "day" SET DATA TYPE TIMESTAMPTZ(3) USING "day" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "QueryRollup" ALTER COLUMN "bucketHour" SET DATA TYPE TIMESTAMPTZ(3) USING "bucketHour" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "QuerySignature" ALTER COLUMN "firstSeen" SET DATA TYPE TIMESTAMPTZ(3) USING "firstSeen" AT TIME ZONE 'UTC',
ALTER COLUMN "lastSeen" SET DATA TYPE TIMESTAMPTZ(3) USING "lastSeen" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "expiresAt" SET DATA TYPE TIMESTAMPTZ(3) USING "expiresAt" AT TIME ZONE 'UTC',
ALTER COLUMN "consumedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "consumedAt" AT TIME ZONE 'UTC',
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

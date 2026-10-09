-- Accounts that predate the verification gate are grandfathered in. The gate
-- exists to bound a public signup page that has not opened yet; it was never
-- meant to evict the people already inside. Every row this touches was created
-- by the operator or by an invite the operator issued.
UPDATE "User" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL;

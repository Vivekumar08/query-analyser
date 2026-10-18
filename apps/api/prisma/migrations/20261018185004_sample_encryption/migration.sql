-- AlterTable
ALTER TABLE "App" ADD COLUMN     "sampleKeyWrapped" JSONB,
ADD COLUMN     "samplePublicKey" TEXT;

-- AlterTable
ALTER TABLE "QuerySignature" ADD COLUMN     "encryptedSample" JSONB;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "national_id_ciphertext" TEXT,
ADD COLUMN     "national_id_last4" VARCHAR(4);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("tenant_id","key")
);

-- Publisher scans only unpublished rows; a partial index keeps that scan tiny forever.
CREATE INDEX outbox_unpublished_idx ON "outbox_events" ("created_at") WHERE "published_at" IS NULL;

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE "customers" ADD CONSTRAINT customers_national_id_pair
  CHECK ((national_id_ciphertext IS NULL) = (national_id_last4 IS NULL));

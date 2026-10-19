-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OFFICER');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('DUE', 'PAID');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "monthly_income_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "principal_cents" BIGINT NOT NULL,
    "annual_rate_bps" INTEGER NOT NULL,
    "term_months" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "principal_cents" BIGINT NOT NULL,
    "interest_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'DUE',
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_id_key" ON "customers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_email_key" ON "customers"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "loans_tenant_id_status_idx" ON "loans"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loans_tenant_id_id_key" ON "loans"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "installments_loan_id_number_key" ON "installments"("loan_id", "number");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_tenant_id_loan_id_fkey" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_loan_id_fkey" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- ROW-LEVEL SECURITY (database-level tenant isolation)
-- The API sets `app.tenant_id` per transaction (SET LOCAL semantics). If it is
-- missing, NULLIF(...) yields NULL, the comparison is never true, and no rows are
-- visible: the policy fails CLOSED. FORCE makes the policies apply to the table
-- owner too (the app role owns the tables).
-- ============================================================================
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

ALTER TABLE "users"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "customers"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "loans"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "loans"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "installments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "documents"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents"    FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs"   FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "users"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON "customers"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON "loans"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON "installments"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation ON "documents"
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Audit log is append-only: only SELECT and INSERT policies exist, so UPDATE and
-- DELETE match no policy and are denied.
CREATE POLICY audit_read ON "audit_logs" FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY audit_insert ON "audit_logs" FOR INSERT WITH CHECK (tenant_id = current_tenant_id());

-- Money must never be negative.
ALTER TABLE "loans"        ADD CONSTRAINT loans_principal_positive CHECK (principal_cents > 0);
ALTER TABLE "loans"        ADD CONSTRAINT loans_term_range CHECK (term_months BETWEEN 1 AND 360);
ALTER TABLE "loans"        ADD CONSTRAINT loans_rate_range CHECK (annual_rate_bps BETWEEN 0 AND 9999);
ALTER TABLE "installments" ADD CONSTRAINT installments_amounts_nonneg CHECK (principal_cents >= 0 AND interest_cents >= 0 AND total_cents = principal_cents + interest_cents);

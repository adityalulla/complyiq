-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('PRIVATE_LIMITED', 'PARTNERSHIP', 'PROPRIETORSHIP', 'LLP', 'PUBLIC_LIMITED');

-- CreateEnum
CREATE TYPE "FilingFrequency" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "BusinessRole" AS ENUM ('OWNER', 'ACCOUNTANT', 'ADMIN');

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CHURNED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('TALLY', 'ZOHO_BOOKS', 'QUICKBOOKS', 'BUSY', 'BANK', 'GST_PORTAL');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "InvoiceDirection" AS ENUM ('SALES', 'PURCHASE');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('TALLY', 'ZOHO_BOOKS', 'QUICKBOOKS', 'BUSY', 'MANUAL_UPLOAD');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_IN_BOOKS', 'MISSING_IN_RETURN', 'DUPLICATE', 'WRONG_GST_RATE');

-- CreateEnum
CREATE TYPE "FilingReturnType" AS ENUM ('GSTR_1', 'GSTR_3B');

-- CreateEnum
CREATE TYPE "FilingStatus" AS ENUM ('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'SUBMITTED', 'FILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEADLINE_REMINDER', 'MISMATCH_ALERT', 'COMPLIANCE_WARNING', 'FILING_CONFIRMATION');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "business_type" "BusinessType" NOT NULL,
    "gstin" TEXT NOT NULL,
    "pan" TEXT NOT NULL,
    "filing_frequency" "FilingFrequency" NOT NULL,
    "compliance_health_score" INTEGER NOT NULL DEFAULT 100,
    "status" "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_users" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "BusinessRole" NOT NULL,

    CONSTRAINT "business_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "api_key_hash" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "external_org_id" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_return_entries" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "supplier_gstin" TEXT,
    "reported_taxable_value" DECIMAL(65,30) NOT NULL,
    "reported_gst_amount" DECIMAL(65,30) NOT NULL,
    "reported_gst_rate" DECIMAL(65,30) NOT NULL,
    "return_period" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_return_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_results" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "gst_return_entry_id" TEXT,
    "status" "ReconciliationStatus" NOT NULL,
    "difference_amount" DECIMAL(65,30),
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by" TEXT,
    "resolution_note" TEXT,

    CONSTRAINT "reconciliation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filings" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "return_type" "FilingReturnType" NOT NULL,
    "period" TEXT NOT NULL,
    "status" "FilingStatus" NOT NULL DEFAULT 'DRAFT',
    "prepared_data" JSONB NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "gstn_arn" TEXT,
    "due_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "filings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "related_invoice_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "message" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "direction" "InvoiceDirection" NOT NULL,
    "supplier_or_customer_name" TEXT NOT NULL,
    "supplier_gstin" TEXT,
    "invoice_date" TIMESTAMP(3) NOT NULL,
    "taxable_value" DECIMAL(65,30) NOT NULL,
    "gst_rate" DECIMAL(65,30) NOT NULL,
    "gst_amount" DECIMAL(65,30) NOT NULL,
    "total_amount" DECIMAL(65,30) NOT NULL,
    "source" "InvoiceSource" NOT NULL,
    "raw_file_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_gstin_key" ON "businesses"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "business_users_business_id_user_id_key" ON "business_users"("business_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_business_id_provider_key" ON "integrations"("business_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "filings_business_id_return_type_period_key" ON "filings"("business_id", "return_type", "period");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_business_id_invoice_number_direction_key" ON "invoices"("business_id", "invoice_number", "direction");

-- AddForeignKey
ALTER TABLE "business_users" ADD CONSTRAINT "business_users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_users" ADD CONSTRAINT "business_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_return_entries" ADD CONSTRAINT "gst_return_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_gst_return_entry_id_fkey" FOREIGN KEY ("gst_return_entry_id") REFERENCES "gst_return_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filings" ADD CONSTRAINT "filings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filings" ADD CONSTRAINT "filings_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add tax totals to Invoice and tax columns to InvoiceLine.
-- Apply manually in Cloud SQL if prisma migrate cannot connect.

ALTER TABLE `Invoice`
  ADD COLUMN `subtotal` DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0;

ALTER TABLE `InvoiceLine`
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0;

-- Increase precision of taxRate from DECIMAL(5,2) to DECIMAL(5,4) to store decimal rates like 0.0700.
ALTER TABLE `InvoiceLine`
  MODIFY COLUMN `taxRate` DECIMAL(5,4) NULL;



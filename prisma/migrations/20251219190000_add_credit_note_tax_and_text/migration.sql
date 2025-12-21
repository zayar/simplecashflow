-- Add tax + text blocks to CreditNote + CreditNoteLine.
-- This is safe to apply manually in Cloud SQL when prisma migrate can't connect locally.

ALTER TABLE `CreditNote`
  ADD COLUMN `subtotal` DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN `customerNotes` TEXT NULL,
  ADD COLUMN `termsAndConditions` TEXT NULL;

ALTER TABLE `CreditNoteLine`
  ADD COLUMN `taxRate` DECIMAL(5,4) NULL,
  ADD COLUMN `taxAmount` DECIMAL(18,2) NOT NULL DEFAULT 0;



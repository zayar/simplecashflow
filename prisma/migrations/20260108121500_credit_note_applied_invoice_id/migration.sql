-- Add applied invoice link for credit notes (separate from source invoiceId)
ALTER TABLE `CreditNote`
  ADD COLUMN `appliedInvoiceId` INTEGER NULL;

-- One credit note can be applied to at most one invoice (v1 model)
CREATE UNIQUE INDEX `CreditNote_appliedInvoiceId_key` ON `CreditNote`(`appliedInvoiceId`);

-- Query performance
CREATE INDEX `CreditNote_companyId_appliedInvoiceId_idx` ON `CreditNote`(`companyId`, `appliedInvoiceId`);

-- FK to Invoice
ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_appliedInvoiceId_fkey` FOREIGN KEY (`appliedInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: previously `invoiceId` was used as "applied to invoice" for POSTED credit notes.
-- Keep historical invoice balances consistent by copying invoiceId -> appliedInvoiceId for POSTED rows only.
UPDATE `CreditNote`
SET `appliedInvoiceId` = `invoiceId`
WHERE `invoiceId` IS NOT NULL
  AND `status` = 'POSTED'
  AND `appliedInvoiceId` IS NULL;


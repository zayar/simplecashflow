-- Add partial credit note application support (apply part of a credit note to invoices).

ALTER TABLE `CreditNote`
  ADD COLUMN `amountApplied` DECIMAL(18, 2) NOT NULL DEFAULT 0.00;

CREATE TABLE `CreditNoteApplication` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `companyId` INT NOT NULL,
  `creditNoteId` INT NOT NULL,
  `invoiceId` INT NOT NULL,
  `appliedDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `createdByUserId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `CreditNoteApplication_companyId_appliedDate_idx` (`companyId`, `appliedDate`),
  INDEX `CreditNoteApplication_companyId_creditNoteId_idx` (`companyId`, `creditNoteId`),
  INDEX `CreditNoteApplication_companyId_invoiceId_idx` (`companyId`, `invoiceId`),
  INDEX `CreditNoteApplication_createdByUserId_fkey` (`createdByUserId`),
  INDEX `CreditNoteApplication_creditNoteId_fkey` (`creditNoteId`),
  INDEX `CreditNoteApplication_invoiceId_fkey` (`invoiceId`),
  CONSTRAINT `CreditNoteApplication_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CreditNoteApplication_creditNoteId_fkey` FOREIGN KEY (`creditNoteId`) REFERENCES `CreditNote` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CreditNoteApplication_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `Invoice` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `CreditNoteApplication_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Backfill legacy "appliedInvoiceId" full-apply behavior into the new application table.
INSERT INTO `CreditNoteApplication` (`companyId`, `creditNoteId`, `invoiceId`, `appliedDate`, `amount`, `createdByUserId`, `createdAt`)
SELECT
  `companyId`,
  `id` AS `creditNoteId`,
  `appliedInvoiceId` AS `invoiceId`,
  `creditNoteDate` AS `appliedDate`,
  `total` AS `amount`,
  NULL AS `createdByUserId`,
  CURRENT_TIMESTAMP(3) AS `createdAt`
FROM `CreditNote`
WHERE `appliedInvoiceId` IS NOT NULL;

UPDATE `CreditNote`
SET `amountApplied` = `total`
WHERE `appliedInvoiceId` IS NOT NULL;

-- Stop using the legacy one-to-one field going forward (applications are source of truth).
UPDATE `CreditNote`
SET `appliedInvoiceId` = NULL
WHERE `appliedInvoiceId` IS NOT NULL;


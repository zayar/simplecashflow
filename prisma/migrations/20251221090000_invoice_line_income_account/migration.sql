-- Add optional income account mapping per invoice line (default UX: Sales Income).
ALTER TABLE `InvoiceLine` ADD COLUMN `incomeAccountId` INTEGER NULL;

CREATE INDEX `InvoiceLine_incomeAccountId_idx` ON `InvoiceLine`(`incomeAccountId`);

ALTER TABLE `InvoiceLine`
  ADD CONSTRAINT `InvoiceLine_incomeAccountId_fkey`
  FOREIGN KEY (`incomeAccountId`) REFERENCES `Account`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;



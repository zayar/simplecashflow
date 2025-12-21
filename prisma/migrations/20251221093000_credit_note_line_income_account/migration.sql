-- Add optional income account mapping per credit note line (default UX: Sales Income).
ALTER TABLE `CreditNoteLine` ADD COLUMN `incomeAccountId` INTEGER NULL;

CREATE INDEX `CreditNoteLine_incomeAccountId_idx` ON `CreditNoteLine`(`incomeAccountId`);

ALTER TABLE `CreditNoteLine`
  ADD CONSTRAINT `CreditNoteLine_incomeAccountId_fkey`
  FOREIGN KEY (`incomeAccountId`) REFERENCES `Account`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;



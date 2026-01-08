-- Credit Note refunds + refunded tracking

ALTER TABLE `CreditNote`
  ADD COLUMN `amountRefunded` DECIMAL(18,2) NOT NULL DEFAULT 0;

CREATE TABLE `CreditNoteRefund` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `creditNoteId` INTEGER NOT NULL,
  `refundDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `bankAccountId` INTEGER NOT NULL,
  `journalEntryId` INTEGER NULL,
  `reference` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `createdByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CreditNoteRefund_journalEntryId_key` (`journalEntryId`),
  INDEX `CreditNoteRefund_companyId_refundDate_idx` (`companyId`, `refundDate`),
  INDEX `CreditNoteRefund_companyId_creditNoteId_idx` (`companyId`, `creditNoteId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CreditNoteRefund`
  ADD CONSTRAINT `CreditNoteRefund_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNoteRefund_creditNoteId_fkey` FOREIGN KEY (`creditNoteId`) REFERENCES `CreditNote`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNoteRefund_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNoteRefund_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNoteRefund_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


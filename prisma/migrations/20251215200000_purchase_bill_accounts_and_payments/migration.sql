-- Purchase Bills v2: line-level chart of account + payments made

-- 1) Add accountId to PurchaseBillLine (nullable for backward compatibility)
ALTER TABLE `PurchaseBillLine`
  ADD COLUMN `accountId` INTEGER NULL;

ALTER TABLE `PurchaseBillLine`
  ADD CONSTRAINT `PurchaseBillLine_accountId_fkey`
  FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `PurchaseBillLine_accountId_idx` ON `PurchaseBillLine`(`accountId`);

-- 2) PurchaseBillPayment
CREATE TABLE `PurchaseBillPayment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `purchaseBillId` INTEGER NOT NULL,
  `paymentDate` DATETIME(3) NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `bankAccountId` INTEGER NOT NULL,
  `journalEntryId` INTEGER NULL,
  `reversedAt` DATETIME(3) NULL,
  `reversalReason` TEXT NULL,
  `reversalJournalEntryId` INTEGER NULL,
  `reversedByUserId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `PurchaseBillPayment_journalEntryId_key`(`journalEntryId`),
  UNIQUE INDEX `PurchaseBillPayment_reversalJournalEntryId_key`(`reversalJournalEntryId`),
  INDEX `PurchaseBillPayment_companyId_paymentDate_idx`(`companyId`, `paymentDate`),
  INDEX `PurchaseBillPayment_purchaseBillId_idx`(`purchaseBillId`),
  CONSTRAINT `PurchaseBillPayment_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillPayment_purchaseBillId_fkey` FOREIGN KEY (`purchaseBillId`) REFERENCES `PurchaseBill`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillPayment_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillPayment_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillPayment_reversalJournalEntryId_fkey` FOREIGN KEY (`reversalJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `PurchaseBillPayment_reversedByUserId_fkey` FOREIGN KEY (`reversedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;



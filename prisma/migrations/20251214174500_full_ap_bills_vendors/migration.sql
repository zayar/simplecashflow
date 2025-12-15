-- Full AP (Accounts Payable) v1:
-- - Vendors
-- - Bills (Expense) posted to Accounts Payable
-- - Bill payments (ExpensePayment) posted to ledger
-- - Company settings: accountsPayableAccountId

-- 1) Company: default Accounts Payable account
ALTER TABLE `Company`
  ADD COLUMN `accountsPayableAccountId` INTEGER NULL;

ALTER TABLE `Company`
  ADD CONSTRAINT `Company_accountsPayableAccountId_fkey`
  FOREIGN KEY (`accountsPayableAccountId`) REFERENCES `Account`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Vendor table
CREATE TABLE `Vendor` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `Vendor_companyId_idx`(`companyId`),
  CONSTRAINT `Vendor_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3) Expense: extend status enum + AP fields
ALTER TABLE `Expense`
  MODIFY `status` ENUM('DRAFT','POSTED','PARTIAL','PAID') NOT NULL;

ALTER TABLE `Expense`
  ADD COLUMN `vendorId` INTEGER NULL,
  ADD COLUMN `dueDate` DATETIME(3) NULL,
  ADD COLUMN `amountPaid` DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `expenseAccountId` INTEGER NULL;

ALTER TABLE `Expense`
  ADD INDEX `Expense_vendorId_idx`(`vendorId`),
  ADD INDEX `Expense_expenseAccountId_idx`(`expenseAccountId`),
  ADD CONSTRAINT `Expense_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Expense_expenseAccountId_fkey` FOREIGN KEY (`expenseAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) ExpensePayment table
CREATE TABLE `ExpensePayment` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `companyId` INTEGER NOT NULL,
  `expenseId` INTEGER NOT NULL,
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
  UNIQUE INDEX `ExpensePayment_journalEntryId_key`(`journalEntryId`),
  UNIQUE INDEX `ExpensePayment_reversalJournalEntryId_key`(`reversalJournalEntryId`),
  INDEX `ExpensePayment_companyId_paymentDate_idx`(`companyId`, `paymentDate`),
  INDEX `ExpensePayment_expenseId_idx`(`expenseId`),

  CONSTRAINT `ExpensePayment_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ExpensePayment_expenseId_fkey` FOREIGN KEY (`expenseId`) REFERENCES `Expense`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ExpensePayment_bankAccountId_fkey` FOREIGN KEY (`bankAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ExpensePayment_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `ExpensePayment_reversalJournalEntryId_fkey` FOREIGN KEY (`reversalJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `ExpensePayment_reversedByUserId_fkey` FOREIGN KEY (`reversedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5) Backfill company.accountsPayableAccountId from default chart (code 2000, LIABILITY)
UPDATE `Company` c
JOIN `Account` a
  ON a.companyId = c.id
 AND a.code = '2000'
 AND a.type = 'LIABILITY'
SET c.accountsPayableAccountId = a.id
WHERE c.accountsPayableAccountId IS NULL;


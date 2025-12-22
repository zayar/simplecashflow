-- Add VOID/APPROVED statuses and audit/void fields for real accounting workflows.
-- NOTE: MySQL enum alteration is done via MODIFY COLUMN with expanded enum sets.

-- --- Enums (status columns) ---
ALTER TABLE `Invoice`
  MODIFY `status` ENUM('DRAFT','APPROVED','POSTED','PAID','PARTIAL','VOID') NOT NULL;

ALTER TABLE `CreditNote`
  MODIFY `status` ENUM('DRAFT','APPROVED','POSTED','VOID') NOT NULL;

ALTER TABLE `Expense`
  MODIFY `status` ENUM('DRAFT','APPROVED','POSTED','PARTIAL','PAID','VOID') NOT NULL;

ALTER TABLE `PurchaseBill`
  MODIFY `status` ENUM('DRAFT','APPROVED','POSTED','PARTIAL','PAID','VOID') NOT NULL;

-- --- JournalEntry: void metadata (soft-void via reversal) ---
ALTER TABLE `JournalEntry`
  ADD COLUMN `voidedAt` DATETIME(3) NULL,
  ADD COLUMN `voidReason` TEXT NULL,
  ADD COLUMN `voidedByUserId` INT NULL,
  ADD COLUMN `updatedByUserId` INT NULL;

-- --- Invoice: void + adjustment metadata ---
ALTER TABLE `Invoice`
  ADD COLUMN `voidedAt` DATETIME(3) NULL,
  ADD COLUMN `voidReason` TEXT NULL,
  ADD COLUMN `voidedByUserId` INT NULL,
  ADD COLUMN `voidJournalEntryId` INT NULL,
  ADD COLUMN `lastAdjustmentJournalEntryId` INT NULL,
  ADD COLUMN `updatedByUserId` INT NULL;

-- --- CreditNote: void + adjustment metadata ---
ALTER TABLE `CreditNote`
  ADD COLUMN `voidedAt` DATETIME(3) NULL,
  ADD COLUMN `voidReason` TEXT NULL,
  ADD COLUMN `voidedByUserId` INT NULL,
  ADD COLUMN `voidJournalEntryId` INT NULL,
  ADD COLUMN `lastAdjustmentJournalEntryId` INT NULL,
  ADD COLUMN `updatedByUserId` INT NULL;

-- --- Expense: void + adjustment metadata ---
ALTER TABLE `Expense`
  ADD COLUMN `voidedAt` DATETIME(3) NULL,
  ADD COLUMN `voidReason` TEXT NULL,
  ADD COLUMN `voidedByUserId` INT NULL,
  ADD COLUMN `voidJournalEntryId` INT NULL,
  ADD COLUMN `lastAdjustmentJournalEntryId` INT NULL,
  ADD COLUMN `updatedByUserId` INT NULL;

-- --- PurchaseBill: void + adjustment metadata ---
ALTER TABLE `PurchaseBill`
  ADD COLUMN `voidedAt` DATETIME(3) NULL,
  ADD COLUMN `voidReason` TEXT NULL,
  ADD COLUMN `voidedByUserId` INT NULL,
  ADD COLUMN `voidJournalEntryId` INT NULL,
  ADD COLUMN `lastAdjustmentJournalEntryId` INT NULL,
  ADD COLUMN `updatedByUserId` INT NULL;

-- --- Indexes / FKs ---
-- Unique "void journal entry" link per document (1 reversal JE per void action)
ALTER TABLE `Invoice` ADD UNIQUE INDEX `Invoice_voidJournalEntryId_key` (`voidJournalEntryId`);
ALTER TABLE `CreditNote` ADD UNIQUE INDEX `CreditNote_voidJournalEntryId_key` (`voidJournalEntryId`);
ALTER TABLE `Expense` ADD UNIQUE INDEX `Expense_voidJournalEntryId_key` (`voidJournalEntryId`);
ALTER TABLE `PurchaseBill` ADD UNIQUE INDEX `PurchaseBill_voidJournalEntryId_key` (`voidJournalEntryId`);

-- Foreign keys to User
ALTER TABLE `JournalEntry`
  ADD CONSTRAINT `JournalEntry_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `JournalEntry_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Invoice`
  ADD CONSTRAINT `Invoice_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Invoice_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Invoice_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Invoice_lastAdjustmentJournalEntryId_fkey` FOREIGN KEY (`lastAdjustmentJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CreditNote`
  ADD CONSTRAINT `CreditNote_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNote_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNote_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `CreditNote_lastAdjustmentJournalEntryId_fkey` FOREIGN KEY (`lastAdjustmentJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Expense`
  ADD CONSTRAINT `Expense_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Expense_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Expense_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Expense_lastAdjustmentJournalEntryId_fkey` FOREIGN KEY (`lastAdjustmentJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `PurchaseBill`
  ADD CONSTRAINT `PurchaseBill_voidedByUserId_fkey` FOREIGN KEY (`voidedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PurchaseBill_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PurchaseBill_voidJournalEntryId_fkey` FOREIGN KEY (`voidJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PurchaseBill_lastAdjustmentJournalEntryId_fkey` FOREIGN KEY (`lastAdjustmentJournalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;



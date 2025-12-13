/*
  Warnings:

  - Added the required column `companyId` to the `InvoiceLine` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `JournalLine` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `ProcessedEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `InvoiceLine` ADD COLUMN `companyId` INTEGER NULL;

-- Backfill InvoiceLine.companyId from parent Invoice
UPDATE `InvoiceLine` il
JOIN `Invoice` i ON i.`id` = il.`invoiceId`
SET il.`companyId` = i.`companyId`
WHERE il.`companyId` IS NULL;

-- If any rows still cannot be backfilled, drop them (safe: derived lines can be recreated from invoice)
DELETE FROM `InvoiceLine` WHERE `companyId` IS NULL;

ALTER TABLE `InvoiceLine` MODIFY `companyId` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `JournalLine` ADD COLUMN `companyId` INTEGER NULL;

-- Backfill JournalLine.companyId from parent JournalEntry
UPDATE `JournalLine` jl
JOIN `JournalEntry` je ON je.`id` = jl.`journalEntryId`
SET jl.`companyId` = je.`companyId`
WHERE jl.`companyId` IS NULL;

-- If any rows still cannot be backfilled, drop them (safe: ledger lines are derived from entries)
DELETE FROM `JournalLine` WHERE `companyId` IS NULL;

ALTER TABLE `JournalLine` MODIFY `companyId` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `ProcessedEvent` ADD COLUMN `companyId` INTEGER NULL;

-- Backfill ProcessedEvent.companyId by matching to Event outbox rows (same eventId)
UPDATE `ProcessedEvent` pe
JOIN `Event` e ON e.`eventId` = pe.`eventId`
SET pe.`companyId` = e.`companyId`
WHERE pe.`companyId` IS NULL AND e.`companyId` IS NOT NULL;

-- If any rows still cannot be backfilled, drop them (safe: at-least-once means projections may replay)
DELETE FROM `ProcessedEvent` WHERE `companyId` IS NULL;

ALTER TABLE `ProcessedEvent` MODIFY `companyId` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `Expense` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `companyId` INTEGER NOT NULL,
    `expenseNumber` VARCHAR(191) NOT NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL,
    `expenseDate` DATETIME(3) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `currency` VARCHAR(191) NULL,
    `itemId` INTEGER NULL,
    `journalEntryId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Expense_journalEntryId_key`(`journalEntryId`),
    INDEX `Expense_companyId_expenseDate_idx`(`companyId`, `expenseDate`),
    INDEX `Expense_companyId_status_idx`(`companyId`, `status`),
    UNIQUE INDEX `Expense_companyId_expenseNumber_key`(`companyId`, `expenseNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IdempotentRequest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `companyId` INTEGER NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `response` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IdempotentRequest_companyId_createdAt_idx`(`companyId`, `createdAt`),
    UNIQUE INDEX `IdempotentRequest_companyId_key_key`(`companyId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `InvoiceLine_companyId_idx` ON `InvoiceLine`(`companyId`);

-- CreateIndex
CREATE INDEX `JournalLine_companyId_idx` ON `JournalLine`(`companyId`);

-- CreateIndex
CREATE INDEX `ProcessedEvent_companyId_idx` ON `ProcessedEvent`(`companyId`);

-- AddForeignKey
ALTER TABLE `JournalLine` ADD CONSTRAINT `JournalLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProcessedEvent` ADD CONSTRAINT `ProcessedEvent_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InvoiceLine` ADD CONSTRAINT `InvoiceLine_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `Item`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `JournalEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `IdempotentRequest` ADD CONSTRAINT `IdempotentRequest_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
